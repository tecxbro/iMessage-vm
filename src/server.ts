/**
 * Milestone 1 — feasibility service.
 *
 * One process: Keiki-facing tool webhooks + HTTPS mini-app origin.
 * A Keiki iMessage agent owns the conversation; its tools call /k/<key>/*
 * here. open returns a presentation object so Keiki delivers the live app
 * card -> card loads /vm/<ref> -> embedded viewer.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getOrCreateComputer,
  wakeComputer,
  createViewer,
  getComputer,
  closeSession,
  takeoverComplete,
  desktopAction,
  type MaritimeComputer,
} from "./maritime.js";
import { TaskRunner, type PersistedSite } from "./tasks.js";
import {
  createChallenge,
  approveChallenge,
  exchangeChallenge,
  challengeStatus,
  sessionRef,
  type PairStore,
} from "./pair.js";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`;
const TOOL_KEY = process.env.KEIKI_TOOL_SECRET ?? "devtoolkey";
const PAIRING = process.env.PAIRING_REQUIRED !== "false";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "..", "data", "store.json");
const NOVNC_FILE = join(__dirname, "..", "static", "novnc-rfb.js");
let novncCache: Buffer | null = null;
function novncBundle(): Buffer {
  if (!novncCache) novncCache = readFileSync(NOVNC_FILE);
  return novncCache;
}

// ---------- tiny persistent store ----------
interface Binding {
  ref: string;
  userId: string; // messaging user id (keiki conversation sender identity)
  channel?: string; // "keiki" | "photon" — each channel gets its own computer
  computerId: string;
  createdAt: string;
  controlToken?: string; // t= from the active control-viewer grant, needed to hand control back
}
interface Store extends PairStore {
  bindings: Record<string, Binding>; // ref -> binding
  byUser: Record<string, string>; // "<channel>:<userId>" -> ref
  dedupe: Record<string, string>; // legacy field, kept for old data compat
  sites?: Record<string, PersistedSite>; // ref -> site spec (survives restarts)
}
function loadStore(): Store {
  try {
    const s = JSON.parse(readFileSync(DATA_FILE, "utf8")) as Store;
    s.bindings ??= {};
    s.byUser ??= {};
    s.dedupe ??= {};
    s.sites ??= {};
    s.challenges ??= {};
    s.sessions ??= {};
    return s;
  } catch {
    return { bindings: {}, byUser: {}, dedupe: {}, sites: {}, challenges: {}, sessions: {} };
  }
}
const store = loadStore();
// migrate legacy unscoped byUser keys to channel-scoped ("keiki" keeps history)
for (const k of Object.keys(store.byUser)) {
  if (!k.includes(":")) {
    store.byUser[`keiki:${k}`] ??= store.byUser[k];
    delete store.byUser[k];
  }
}
function saveStore() {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function bindingForUser(userId: string, channel = "keiki"): Binding {
  const key = `${channel}:${userId}`;
  const existingRef = store.byUser[key];
  if (existingRef && store.bindings[existingRef]) return store.bindings[existingRef];
  const ref = "vm_" + createHash("sha256").update(key).digest("hex").slice(0, 16) + randomBytes(3).toString("hex");
  const b: Binding = { ref, userId, channel, computerId: "", createdAt: new Date().toISOString() };
  store.bindings[ref] = b;
  store.byUser[key] = ref;
  saveStore();
  return b;
}

/** every ref this person owns, across channels — a connect code texted on
 *  either line may approve whichever card is showing it */
function ownedRefs(userId: string): string[] {
  const refs: string[] = [];
  for (const ch of ["keiki", "photon"]) {
    const r = store.byUser[`${ch}:${userId}`];
    if (r && store.bindings[r]) refs.push(r);
  }
  const legacy = store.byUser[userId];
  if (legacy && store.bindings[legacy]) refs.push(legacy);
  return refs;
}

async function ensureComputer(b: Binding): Promise<MaritimeComputer> {
  if (!b.computerId) {
    const c = await getOrCreateComputer(`imessage-${b.channel ?? "keiki"}-${b.userId}`, { name: `im-${(b.channel ?? "k").slice(0, 1)}-${b.userId.slice(-6)}` });
    b.computerId = c.id;
    saveStore();
    return c;
  }
  const c = await getComputer(b.computerId);
  if (c.status === "sleeping" || c.status === "stopped") return wakeComputer(b.computerId);
  return c;
}

// ---------- mini app html ----------
function page(b: Binding): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no, interactive-widget=resizes-content">
<title>Maritime Computer</title>
<meta name="og:title" content="Maritime Computer">
<meta name="og:description" content="A live cloud desktop, in your conversation.">
<style>
  :root{--ink:#1c1c1e;--mut:#8e8e93;--acc:#0a84ff;--ok:#34c759;--err:#ff3b30;--panel:rgba(16,16,20,.82)}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{height:100%;margin:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:var(--ink);background:#000;overscroll-behavior:none;user-select:none;-webkit-user-select:none}
  #card{position:fixed;inset:0;overflow:hidden;background:#eef2f6}
  #card.controlled{box-shadow:inset 0 0 0 3px rgba(10,132,255,.9)}
  /* the desktop is rendered by OUR RFB client (noVNC) straight on the raw
     framebuffer — no Maritime page, no iframe, so no foreign chrome exists */
  #screen{position:absolute;inset:0;background:#0a0a0a;overflow:hidden}
  #screen>div{position:relative;z-index:1;background:transparent !important}
  #screen canvas{display:block;margin:auto}
  /* ambilight: a blurred cover-scaled copy of the stream fills the letterbox
     area — the gap reads as design, not empty matte */
  #amb{position:absolute;inset:0;z-index:0;width:100%;height:100%;filter:blur(24px) brightness(.78) saturate(1.4);transform:scale(1.06);pointer-events:none}
  /* veil — connecting / waking / hiccup / stopped surfaces */
  #veil{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5vmin;background:#eef2f6;transition:opacity .3s}
  #veil.hide{opacity:0;pointer-events:none}
  #veil.tap{cursor:pointer}
  .ship{position:absolute;inset:0;width:100%;height:100%}
  #veilmsg{position:relative;font-size:3.8vmin;color:var(--mut);font-weight:500}
  /* control bar */
  #bar{position:absolute;left:0;right:0;bottom:0;z-index:5;display:flex;align-items:center;gap:2.8vmin;padding:10vmin 4.5vmin calc(4.5vmin + env(safe-area-inset-bottom));background:linear-gradient(180deg,transparent 0%,rgba(0,0,0,.28) 100%)}
  #bar.hidden{display:none}
  /* sheet presentation (live:false): control bar becomes a top header */
  #card.sheet #bar{top:0;bottom:auto;padding:calc(4.5vmin + env(safe-area-inset-top)) 4.5vmin 10vmin;background:linear-gradient(180deg,rgba(0,0,0,.28) 0%,transparent 100%)}
  /* sheet-mode keyboard bar — remote typing at the bottom. Row metrics
     mirror the header exactly (flex field + round button, same height/gap)
     so the input lands the same width as the pill above it. */
  #kb{position:absolute;left:0;right:0;bottom:0;z-index:5;display:none;align-items:center;gap:2.8vmin;padding:3vmin 4.5vmin calc(3vmin + env(safe-area-inset-bottom));background:linear-gradient(0deg,rgba(0,0,0,.32) 0%,transparent 100%)}
  #card.sheet #kb{display:flex}
  #card.sheet #kb.hidden{display:none}
  #kbIn{flex:1;min-width:0;height:14.5vmin;border:0;border-radius:999px;padding:0 5vmin;background:var(--panel);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);color:#fff;font-size:16px;outline:none}
  #kbIn::placeholder{color:rgba(255,255,255,.55)}
  .kbtn{width:14.5vmin;height:14.5vmin}
  /* sheet puts the control toggle on the keyboard bar instead of the header */
  #card.sheet #ctlBtn{display:none}
  #pill{flex:1;min-width:0;height:14.5vmin;display:flex;align-items:center;gap:2.4vmin;padding:0 5vmin;border-radius:999px;background:var(--panel);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);color:#fff}
  #pill.done{background:rgba(16,60,32,.85)}
  #pillic{flex:0 0 auto;width:4.8vmin;height:4.8vmin;display:flex;align-items:center;justify-content:center}
  #pillic svg{width:100%;height:100%}
  .spin{width:4.4vmin;height:4.4vmin;border-radius:50%;border:.8vmin solid rgba(255,255,255,.35);border-top-color:#fff;animation:sp .9s linear infinite}
  @keyframes sp{to{transform:rotate(360deg)}}
  #pilltx{font-size:4.1vmin;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rbtn{flex:0 0 auto;width:14.5vmin;height:14.5vmin;border:0;border-radius:50%;display:grid;place-items:center;background:var(--panel);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);color:#fff;cursor:pointer;transition:transform .15s,background .2s}
  .rbtn svg{width:46%;height:46%}
  .rbtn:active{transform:scale(.92)}
  .rbtn.on{background:var(--acc)}
  /* task progress sheet */
  #tasks{position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;background:#fff;animation:vin .24s ease both}
  #tasks.hidden{display:none}
  .thead{display:flex;align-items:center;justify-content:space-between;padding:5vmin 5vmin 2.5vmin}
  .thead h2{margin:0;font-size:5.2vmin;font-weight:600;letter-spacing:-.01em}
  .xbtn{width:8.5vmin;height:8.5vmin;border:0;border-radius:50%;display:grid;place-items:center;background:rgba(120,120,128,.12);color:#3a3a3c;cursor:pointer}
  .xbtn svg{width:40%;height:40%}
  #tlist{flex:1;margin:0;padding:1vmin 5vmin;list-style:none;overflow-y:auto}
  .trow{display:flex;gap:3vmin;align-items:flex-start;padding:2.8vmin 0;border-bottom:1px solid #f0f0f3;animation:tin .3s ease both}
  @keyframes tin{from{opacity:0;transform:translateY(1.5vmin)}to{opacity:1;transform:none}}
  .trow:last-child{border-bottom:0}
  .ring{flex:0 0 auto;width:5vmin;height:5vmin;margin-top:.6vmin;border-radius:50%;border:.55vmin solid var(--ink);display:grid;place-items:center;color:#fff}
  .ring svg{width:65%;height:65%}
  .trow.done .ring{background:var(--ink)}
  .trow.pending .ring,.trow.cancelled .ring{border-color:#d1d1d6}
  .trow.error .ring{border-color:var(--err);color:var(--err)}
  .tt{font-size:3.9vmin;line-height:1.32;font-weight:450}
  .trow.done .tt{color:var(--mut)}
  .trow.pending .tt{color:#aeaeb2}
  .trow.cancelled .tt{color:#aeaeb2;text-decoration:line-through}
  .trow.error .tt{color:var(--err)}
  .empty{padding:8vmin 2vmin;text-align:center;color:#aeaeb2;font-size:3.8vmin}
  .tfoot{display:flex;justify-content:center;padding:2.5vmin 0 calc(4.5vmin + env(safe-area-inset-bottom))}
  #cancelBtn{border:0;background:none;color:var(--err);font-size:3.6vmin;font-weight:500;cursor:pointer;padding:1.5vmin 4vmin}
  /* cancel confirmation */
  #dlg{position:absolute;inset:0;z-index:20;display:grid;place-items:center;background:rgba(0,0,0,.32);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);animation:fin .18s ease both}
  #dlg.hidden{display:none}
  .dlgcard{width:78%;background:rgba(255,255,255,.96);border-radius:6vmin;padding:6vmin 5vmin 4vmin;text-align:center;animation:din .22s cubic-bezier(.34,1.4,.64,1) both}
  .dlgcard h3{margin:0 0 1.5vmin;font-size:4.6vmin;font-weight:600}
  .dlgcard p{margin:0 0 4.5vmin;font-size:3.4vmin;line-height:1.35;color:#6e6e73}
  .dlgbtns{display:flex;gap:2.5vmin}
  .dlgbtns button{flex:1;border:0;border-radius:999px;padding:2.8vmin 0;font-size:3.6vmin;font-weight:600;cursor:pointer;background:rgba(120,120,128,.14);color:var(--ink)}
  .dlgbtns .danger{background:rgba(255,59,48,.12);color:var(--err)}
  /* pairing overlay */
  #pair{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;background:#eef2f6}
  #pair.hidden{display:none}
  .paircard{display:flex;flex-direction:column;align-items:center;gap:4vmin;padding:8vmin 6vmin;max-width:86vmin;text-align:center}
  .paircard>:not(.ship){position:relative}
  .pairtitle{font-size:5.4vmin;font-weight:600}
  .pairsub{font-size:3.6vmin;color:var(--mut);line-height:1.5}
  .connectbtn{background:var(--acc);color:#fff;border:0;border-radius:999px;padding:3vmin 8vmin;font-size:4vmin;font-weight:600;cursor:pointer}
  #paircode.hidden,.hidden{display:none}
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9vmin;letter-spacing:2.4vmin;color:var(--acc);font-weight:700;padding:2vmin 0 2vmin 2.4vmin}
  @keyframes vin{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:none}}
  @keyframes fin{from{opacity:0}}
  @keyframes din{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}
</style>
</head>
<body>
<div id="card">
  <div id="screen"><canvas id="amb"></canvas></div>
  <div id="veil"><canvas class="ship" id="ship1"></canvas><div id="veilmsg">Connecting to Maritime&hellip;</div></div>
  <div id="bar">
    <div id="pill"><span id="pillic"></span><span id="pilltx">Maritime Computer</span></div>
    <button type="button" id="ctlBtn" class="rbtn" aria-label="Take control" title="Take control">
      <svg viewBox="0 0 20 20" fill="none"><rect x="2.5" y="4" width="15" height="10" rx="1.8" stroke="currentColor" stroke-width="1.6"/><path d="M7 17h6M10 14v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>
    <button type="button" id="lstBtn" class="rbtn" aria-label="Task progress" title="Task progress">
      <svg viewBox="0 0 20 20" fill="none"><path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="3.8" cy="5.5" r="1.1" fill="currentColor"/><circle cx="3.8" cy="10" r="1.1" fill="currentColor"/><circle cx="3.8" cy="14.5" r="1.1" fill="currentColor"/></svg>
    </button>
  </div>
  <div id="kb" class="hidden">
    <input id="kbIn" type="text" placeholder="Type — it lands on the computer live" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send">
    <button type="button" id="kbComp" class="rbtn kbtn" aria-label="Take control" title="Take control"><svg viewBox="0 0 20 20" fill="none"><rect x="2.5" y="4" width="15" height="10" rx="1.8" stroke="currentColor" stroke-width="1.6"/><path d="M7 17h6M10 14v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
  </div>
  <div id="tasks" class="hidden">
    <header class="thead">
      <h2>Task Progress</h2>
      <button type="button" class="xbtn" id="tasksX" aria-label="Back to live view">
        <svg viewBox="0 0 14 14"><path d="M2 2l10 10M12 2 2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
    </header>
    <ul id="tlist"></ul>
    <footer class="tfoot"><button type="button" id="cancelBtn">Cancel task</button></footer>
  </div>
  <div id="dlg" class="hidden">
    <div class="dlgcard" role="alertdialog" aria-modal="true">
      <h3>Cancel task?</h3>
      <p>The agent is still working. Cancelling will stop all current tasks.</p>
      <div class="dlgbtns"><button type="button" id="keepBtn">Keep going</button><button type="button" id="yesBtn" class="danger">Cancel task</button></div>
    </div>
  </div>
  <div id="pair" class="hidden">
    <div class="paircard">
      <canvas class="ship" id="ship2"></canvas>
      <div class="pairtitle">Maritime Computer</div>
      <div class="pairsub" id="pairsub">This computer is private. Connect from the phone that owns the conversation.</div>
      <button type="button" id="connectBtn" class="connectbtn">Connect</button>
      <div id="paircode" class="hidden">
        <div class="code" id="codetext"></div>
        <div class="pairsub">text <b>connect <span id="codeecho"></span></b> in this chat</div>
      </div>
    </div>
  </div>
</div>
<script>
var ref = ${JSON.stringify(b.ref)};
var $ = function (id) { return document.getElementById(id); };
var screenEl = $("screen"), veil = $("veil"), veilMsg = $("veilmsg"), bar = $("bar");
var pill = $("pill"), pillTx = $("pilltx"), pillIc = $("pillic");
var tasksEl = $("tasks"), tlist = $("tlist"), dlg = $("dlg"), pairEl = $("pair");
var mode = "watch", refreshTimer = null, lastItems = "", veilWhy = "";
var sessKey = "sess_" + ref;
var session = localStorage.getItem(sessKey) || null;
var pairPoll = null;
/* sheet presentation comes from the live:false card (?view=sheet) — the
   control bar sits on top and a remote-typing keyboard bar sits at bottom */
var isSheet = /[?&]view=sheet\\b/.test(location.search);
if (isSheet) $("card").classList.add("sheet");
var kbEl = $("kb"), kbIn = $("kbIn"), kbComp = $("kbComp"), ctlBtnEl = $("ctlBtn");
/* the typing bar shows by default in the sheet; it hides while the veil,
   pair gate, task sheet, or cancel dialog is covering the screen */
var kbOn = isSheet;
function applyKb() {
  var hidden = !isSheet || !kbOn || veilWhy !== "" || !pairEl.classList.contains("hidden") || !tasksEl.classList.contains("hidden") || !dlg.classList.contains("hidden");
  kbEl.classList.toggle("hidden", hidden);
  layoutKb();
}
/* keep the typing bar glued above the phone keyboard and the header glued
   to the visible top. #screen itself never resizes — shrinking it into the
   band above the keyboard crushed the desktop into an unreadable strip, so
   the bar floats over the screen like the header does and the visible top
   of the desktop stays at full scale. */
function layoutKb() {
  var lift = 0, offTop = 0;
  if (window.visualViewport) {
    lift = Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop);
    offTop = Math.max(0, visualViewport.offsetTop);
  }
  kbEl.style.bottom = lift + "px";
  if (isSheet) bar.style.top = offTop + "px";
}
var streamUp = false, veilTimer = null, grantExp = 0, grantMode = "";

/* tap beacon: fire-and-forget GET on any gesture — lets the server see
   whether the host webview delivers touches to the page at all. */
["click", "touchstart"].forEach(function (ev) {
  document.addEventListener(ev, function (e) {
    try {
      var t = e.touches && e.touches[0] ? e.touches[0] : e;
      fetch("/vm/" + ref + "/diag?ev=" + ev + "&x=" + Math.round(t.clientX || 0) + "&y=" + Math.round(t.clientY || 0), { cache: "no-store" }).catch(function () {});
    } catch (err) {}
  }, { capture: true, passive: true });
});

/* ---------- dithered ship (maritime-dither kit: Bayer threshold over a field) ---------- */
var BAYER = [0,48,12,60,3,51,15,63,32,16,44,28,35,19,47,31,8,56,4,52,11,59,7,55,40,24,36,20,43,27,39,23,2,50,14,62,1,49,13,61,34,18,46,30,33,17,45,29,10,58,6,54,9,57,5,53,42,26,38,22,41,25,37,21].map(function (v) { return (v + 0.5) / 64; });
function nhash(a, b2) { var f = Math.sin(a * 127.1 + b2 * 311.7) * 43758.5453; f -= Math.floor(f); var s = Math.sin(f * 1000 + a * 269.5 + b2 * 183.3) * 24634.6345; return s - Math.floor(s); }
function sm(p) { return p * p * (3 - 2 * p); }
function nse(x, y) { var x0 = Math.floor(x), y0 = Math.floor(y), fx = sm(x - x0), fy = sm(y - y0); var t = nhash(x0, y0) + (nhash(x0 + 1, y0) - nhash(x0, y0)) * fx; var bt = nhash(x0, y0 + 1) + (nhash(x0 + 1, y0 + 1) - nhash(x0, y0 + 1)) * fx; return t + (bt - t) * fy; }
var WO = [[1, 0.5], [2.1, 0.3], [4.3, 0.2]];
function crests(x, y, t) { var s = 0, w = 0; for (var i = 0; i < WO.length; i++) { s += WO[i][1] * nse(x * 4.5 * WO[i][0] + t * 0.12 * WO[i][0], y * 3.5 * WO[i][0] - t * 0.12 * 0.6); w += WO[i][1]; } var r = 1 - Math.abs(2 * (s / w) - 1); return Math.pow(r, 3); }
function halfW(u) { if (u > 0.05) { var p = (u - 0.05) / 0.95; return Math.pow(1 - Math.pow(p, 1.7), 0.65); } if (u < -0.7) return 1 - 0.28 * ((-0.7 - u) / 0.3); return 1; }
function boatX(t, aspect) { var travel = aspect + 1.6 + 2.6, per = travel / 0.6 + 2, run = (((t % per) + per) % per) * 0.6; return run > travel ? null : aspect + 0.8 - run; }
function hullAt(x, y, bx) { var u = (bx - x) / 0.4; if (u < -1 || u > 1) return 0; var a = Math.abs((y - 0.5) / 0.11); var h = halfW(u); if (a > h) return 0; if (a > h * 0.7) return 0.95; if (u >= 0.62 && u <= 0.72 && a <= 0.18) return 1; if (u >= -0.6 && u <= -0.1 && a <= 0.55) return 0.85; if (u >= 0.15 && u <= 0.5 && a <= 0.35) return 0.12; return 0.3; }
var WAKE_TAN = Math.tan(7 * Math.PI / 180);
function wakeAt(x, y, t, bx) { var behind = x - (bx + 0.4); if (behind < 0 || behind > 2.6) return 0; var off = Math.abs(y - 0.5), edge = 0.088 + behind * WAKE_TAN; if (off > edge) return 0; var env = (1 - behind / 2.6) * (1 - Math.pow(off / edge, 4)); return env * (0.06 + 0.69 * crests(x, y, t)); }
function shipField(x, y, t, aspect) { var water = 0.2 * crests(x, y, t); var bx = boatX(t, aspect); if (bx === null) return water; var h = hullAt(x, y, bx); var w = wakeAt(x, y, t, bx); return Math.max(h, w, water); }
function shipOn(cv) {
  var ctx = cv.getContext("2d"), t0 = 0, last = 0;
  function draw(now) {
    var dpr = window.devicePixelRatio || 1, w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w || !h) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    var cell = 1.5 * dpr, rad = 0.62 * dpr, cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
    var aspect = cv.clientWidth / cv.clientHeight, t = (now - t0) / 1000;
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = "rgba(11,18,32,0.8)"; ctx.beginPath();
    for (var j = 0; j < rows; j++) { var y = (j + 0.5) / rows; for (var i = 0; i < cols; i++) { var x = ((i + 0.5) / cols) * aspect; var b = shipField(x, y, t, aspect); if (b <= 0 || b < BAYER[(j % 8) * 8 + (i % 8)]) continue; ctx.rect((i + 0.5) * cell - rad, (j + 0.5) * cell - rad, rad * 2, rad * 2); } }
    ctx.fill();
  }
  /* the veil hides with opacity:0 (still laid out — offsetParent stays set),
     so the .hide class is checked explicitly; without it the whole dither
     field keeps computing invisibly under the live stream. The clock also
     restarts on each resurface so the boat always sails in from the edge
     instead of popping in mid-cycle. */
  function loop(now) {
    requestAnimationFrame(loop);
    var hid = !cv.offsetParent || !!cv.closest(".hide");
    if (hid) { t0 = 0; return; }
    if (now - last < 50) return;
    if (!t0) t0 = now;
    last = now;
    draw(now);
  }
  requestAnimationFrame(loop);
}
shipOn($("ship1")); shipOn($("ship2"));

/* ---------- pill ---------- */
var ICONS = {
  spin: '<span class="spin"></span>',
  check: '<svg viewBox="0 0 16 16"><path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dot: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>',
  err: '<svg viewBox="0 0 16 16"><path d="M8 3v6M8 12.5v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
};
var pillIcon = "";
function setPill(text, icon, done) {
  pillTx.textContent = text;
  /* rewriting innerHTML restarts the spin/dot icon — cache it so a steady
     state poll doesn't make the icon flash every 3s */
  if (pillIcon !== icon) { pillIcon = icon; pillIc.innerHTML = ICONS[icon] || ""; }
  pillIc.style.color = done ? "#34c759" : icon === "err" ? "#ff453a" : "#fff";
  pill.className = done ? "done" : "";
}
function showVeil(msg, why, tap) {
  veilWhy = why;
  veilMsg.textContent = msg || "";
  veilMsg.style.display = msg ? "" : "none";
  veil.classList.toggle("tap", !!tap);
  veil.classList.remove("hide");
  bar.classList.add("hidden");
  applyKb();
}
function hideVeil() {
  veilWhy = "";
  veil.classList.add("hide");
  bar.classList.remove("hidden");
  applyKb();
}
veil.onclick = function () { if (veil.classList.contains("tap")) loadViewer(true); };

/* RFB stream (noVNC). The veil lifts only once the framebuffer handshake is
   done and pixels are flowing — user sees ship -> desktop, nothing between. */
var streamGen = 0, streamUrl = "", rfb = null, RFB = null;
import("/static/novnc-rfb.js").then(function (m) {
  // esbuild CJS->ESM interop can nest the class one level deep
  var d = m.default;
  RFB = typeof d === "function" ? d : d && d.default;
}).catch(function (e) { console.error("rfb load", e); });
function connectStream() {
  if (!RFB || !streamUrl) { setTimeout(connectStream, 600); return; }
  var gen = ++streamGen; // bump first so the old instance's disconnect event is ignored
  if (rfb) { try { rfb.disconnect(); } catch (e) {} rfb = null; }
  screenEl.innerHTML = "";
  if (typeof ambCv !== "undefined") screenEl.appendChild(ambCv); // keep ambilight behind the stream canvas
  rfb = new RFB(screenEl, streamUrl, { shared: true, viewOnly: mode !== "control", wsProtocols: [] });
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.showDotCursor = mode === "control";
  rfb.focusOnClick = true;
  rfb.addEventListener("connect", function () {
    if (gen !== streamGen) return;
    streamUp = true;
    clearTimeout(veilTimer);
    setTimeout(function () { if (gen === streamGen && (veilWhy === "connect" || veilWhy === "hiccup")) hideVeil(); }, 1200);
  });
  rfb.addEventListener("disconnect", function () {
    if (gen !== streamGen) return;
    streamUp = false;
    /* reconnect quietly first — the veil only surfaces if the stream stays
       down, so a brief socket flap never flashes the ship overlay */
    clearTimeout(veilTimer);
    veilTimer = setTimeout(function () { showVeil("", "hiccup", true); }, 1500);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { loadViewer(false); }, 900);
  });
}

/* ambilight fill — downscaled blurred copy of the stream behind the sharp one.
   Runs only while the stream is visible. */
var ambCv = $("amb"), ambCtx = ambCv.getContext("2d");
(function ambLoop() {
  requestAnimationFrame(ambLoop);
  var src = screenEl.querySelector("canvas:not(#amb)");
  if (!src || !src.width || !src.height || !ambCv.offsetParent) return;
  var sw = screenEl.clientWidth, sh = screenEl.clientHeight;
  var tw = Math.round(sw / 6), th = Math.round(sh / 6); // cheap: blur happens at 1/6 res
  if (ambCv.width !== tw || ambCv.height !== th) { ambCv.width = tw; ambCv.height = th; }
  var s = Math.max(tw / src.width, th / src.height); // cover
  try {
    ambCtx.drawImage(src, (tw - src.width * s) / 2, (th - src.height * s) / 2, src.width * s, src.height * s);
  } catch (e) {}
})();

async function api(path, body) {
  var r = await fetch("/vm/" + ref + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(session ? { "x-session": session } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { showPair(); throw new Error("unauthorized"); }
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}
function showPair() {
  pairEl.classList.remove("hidden");
  applyKb();
  setPill("Pair this device", "dot");
  // no click needed — mint/show the code as soon as the gate appears
  if (!pairBusy && $("paircode").classList.contains("hidden")) startPair();
}
function hidePair() { pairEl.classList.add("hidden"); applyKb(); }

var pairBusy = false;
async function startPair(fresh) {
  pairBusy = true;
  $("pairsub").textContent = "Getting a code…";
  try {
    var j;
    try { j = await api("/pair/start", { fresh: !!fresh }); }
    catch (e1) {
      // some host webviews drop POSTs — retry as GET before giving up
      var gr = await fetch("/vm/" + ref + "/pair/start?get=1" + (fresh ? "&fresh=1" : ""));
      j = await gr.json();
    }
    $("connectBtn").classList.remove("hidden");
    $("connectBtn").textContent = "New code";
    $("paircode").classList.remove("hidden");
    $("codetext").textContent = j.code;
    $("codeecho").textContent = j.code;
    $("pairsub").textContent = "Waiting for the owner to confirm…";
    clearInterval(pairPoll);
    pairPoll = setInterval(async () => {
      try {
        var r = await fetch("/vm/" + ref + "/pair/status?code=" + j.code);
        var s = await r.json();
        if (s.status === "approved" && s.session) {
          session = s.session;
          localStorage.setItem(sessKey, session);
          clearInterval(pairPoll);
          hidePair();
          $("connectBtn").classList.remove("hidden");
          $("paircode").classList.add("hidden");
          loadViewer(true);
        } else if (s.status === "expired" || s.status === "unknown") {
          clearInterval(pairPoll);
          $("pairsub").textContent = "Refreshing code…";
          setTimeout(startPair, 1500);
        }
      } catch {}
    }, 2000);
  } catch (e) {
    $("pairsub").textContent = "Couldn't start pairing: " + e;
  }
  pairBusy = false;
}
$("connectBtn").onclick = function () { startPair(true); };

async function checkAccess() {
  try {
    var r = await fetch("/vm/" + ref + "/state", { headers: session ? { "x-session": session } : {} });
    if (r.status === 401) { showPair(); return false; }
    return true;
  } catch { return true; }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(function () { loadViewer(false); }, Math.max(grantExp - Date.now() - 30000, 60000));
}
async function loadViewer(announce) {
  if (announce) showVeil("", "connect");
  setPill("Maritime Computer", "dot");
  try {
    /* a dropped socket reuses the live grant while it's still fresh — minting
       a new control grant on every flap re-triggers the takeover handshake
       and can knock the stream right back down */
    if (streamUrl && grantMode === mode && Date.now() < grantExp - 60000) {
      if (!streamUp) connectStream();
      scheduleRefresh();
      return;
    }
    var g = await api("/viewer", { mode: mode });
    grantExp = new Date(g.expiresAt).getTime();
    grantMode = mode;
    if (g.wsUrl !== streamUrl) { streamUrl = g.wsUrl; connectStream(); }
    else if (!streamUp) connectStream();
    else setTimeout(function () { if (veilWhy === "connect") hideVeil(); }, 400);
    scheduleRefresh();
  } catch (e) {
    if (e && e.message === "unauthorized") return;
    showVeil("", "hiccup", true);
    refreshTimer = setTimeout(function () { loadViewer(false); }, 4000);
  }
}

/* ---------- controls ---------- */
function toggleControl() {
  mode = mode === "watch" ? "control" : "watch";
  ctlBtnEl.className = "rbtn" + (mode === "control" ? " on" : "");
  kbComp.classList.toggle("on", mode === "control");
  $("card").className = (isSheet ? "sheet " : "") + (mode === "control" ? "controlled" : "");
  clearTimeout(veilTimer);
  veilTimer = setTimeout(function () { if (!streamUp) showVeil("", "connect"); }, 1200);
  loadViewer(false);
}
ctlBtnEl.onclick = toggleControl;
$("lstBtn").onclick = function () { tasksEl.classList.remove("hidden"); bar.classList.add("hidden"); kbIn.blur(); applyKb(); };
$("tasksX").onclick = function () { tasksEl.classList.add("hidden"); bar.classList.remove("hidden"); applyKb(); };
$("cancelBtn").onclick = function () { dlg.classList.remove("hidden"); };
$("keepBtn").onclick = function () { dlg.classList.add("hidden"); };
$("yesBtn").onclick = async function () {
  dlg.classList.add("hidden");
  try { await api("/task/cancel", {}); } catch (e) {}
};

/* ---------- sheet keyboard — live remote typing (live:false presentation) ----------
   Every edit to the field diffs against the previous value and the delta is
   forwarded immediately — characters land on the computer as you type.
   Control mode sends keysyms over the RFB socket; watch mode batches ops
   through POST /type (REST actions only work while the agent holds the
   desktop). */
var XK_MAP = { 9: 0xff09, 10: 0xff0d, 13: 0xff0d, 27: 0xff1b, 8: 0xff08 };
function keysymOf(cp) { return XK_MAP[cp] || (cp < 0x100 ? cp : (0x01000000 | cp)); }
function rfbType(text) {
  for (var i = 0; i < text.length; i++) {
    var cp = text.codePointAt(i);
    if (cp > 0xffff) i++; // astral chars occupy two UTF-16 units
    rfb.sendKey(keysymOf(cp));
  }
}
var restOps = [], restT = null;
function restPush(op) {
  restOps.push(op);
  clearTimeout(restT);
  restT = setTimeout(function () {
    var ops = restOps; restOps = [];
    if (ops.length) api("/type", { ops: ops }).catch(function () {});
  }, 250);
}
function typeDiff(del, ins) {
  if (rfb && streamUp && mode === "control") {
    while (del-- > 0) rfb.sendKey(0xff08);
    rfbType(ins);
  } else {
    if (del > 0) restPush({ del: del });
    if (ins) restPush({ text: ins });
  }
}
var kbPrev = "";
kbIn.addEventListener("input", function () {
  var v = kbIn.value, p = kbPrev; kbPrev = v;
  var i = 0, n0 = p.length, n1 = v.length;
  while (i < n0 && i < n1 && p[i] === v[i]) i++;          // common prefix
  var s0 = n0, s1 = n1;
  while (s0 > i && s1 > i && p[s0 - 1] === v[s1 - 1]) { s0--; s1--; } // common suffix
  var del = s0 - i, ins = v.slice(i, s1);
  if (del || ins) typeDiff(del, ins);
  if (ins.indexOf("\\n") >= 0 || ins.indexOf("\\r") >= 0) {
    setTimeout(function () { kbIn.value = ""; kbPrev = ""; }, 0);
  }
});
/* single-line inputs never emit \n — the return key arrives as an Enter
   keydown, so forward it as a remote Return and clear like a sent message */
kbIn.addEventListener("keydown", function (e) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (rfb && streamUp && mode === "control") rfb.sendKey(0xff0d);
  else restPush({ key: "Return" });
  kbIn.value = ""; kbPrev = "";
});
/* the monitor button takes/releases control — same as the header's control
   button on live cards (hidden in the sheet). preventDefault keeps the phone
   keyboard open while the button is tapped. */
kbComp.addEventListener("pointerdown", function (e) { e.preventDefault(); });
kbComp.onclick = toggleControl;
/* the keyboard lifts the bar above itself — recompute on every viewport
   signal: iOS fires vv resize AND scroll (offsetTop), Android/webview
   resizes may only hit window resize. Focus timers cover the slide-up
   animation, blur settles the bar back at the bottom edge. */
if (isSheet) {
  if (window.visualViewport) {
    visualViewport.addEventListener("resize", layoutKb);
    visualViewport.addEventListener("scroll", layoutKb);
  }
  window.addEventListener("resize", layoutKb);
}
kbIn.addEventListener("focus", function () { layoutKb(); setTimeout(layoutKb, 120); setTimeout(layoutKb, 350); setTimeout(layoutKb, 700); });
kbIn.addEventListener("blur", function () { setTimeout(layoutKb, 120); setTimeout(layoutKb, 400); });
kbIn.addEventListener("blur", function () { setTimeout(layoutKb, 50); });

function renderTasks(items) {
  var key = JSON.stringify(items);
  if (key === lastItems) return;
  lastItems = key;
  tlist.innerHTML = "";
  if (!items || !items.length) {
    tlist.innerHTML = '<li class="empty">No tasks yet — text the chat what you want the computer to do.</li>';
    return;
  }
  items.forEach(function (it) {
    var li = document.createElement("li");
    li.className = "trow " + it.status;
    var ring = document.createElement("span");
    ring.className = "ring";
    if (it.status === "done") ring.innerHTML = '<svg viewBox="0 0 12 12"><path d="M2.5 6.5 5 9 9.5 3.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    if (it.status === "error") ring.innerHTML = '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3 3 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    var tt = document.createElement("span");
    tt.className = "tt";
    tt.textContent = it.text;
    li.appendChild(ring);
    li.appendChild(tt);
    tlist.appendChild(li);
  });
}

/* ---------- state poll: drives pill + task list ---------- */
setInterval(async () => {
  try {
    var r = await fetch("/vm/" + ref + "/state", { headers: session ? { "x-session": session } : {} });
    if (r.status === 401) { showPair(); return; }
    var s = await r.json();
    renderTasks(s.items || []);
    /* a human actively holding control shouldn't get splashed by an idle
       status flap — the stream dying raises the hiccup veil on its own */
    if (s.computer === "sleeping" && mode !== "control") showVeil("", "waking");
    else if (s.computer === "stopped") {
      showVeil("Session ended — reconnecting…", "stopped");
      setTimeout(function () { if (veilWhy === "stopped") loadViewer(false); }, 6000);
    }
    else if (s.computer === "ready" && (veilWhy === "waking" || veilWhy === "stopped")) hideVeil();
    if (mode === "control") { setPill("You're in control", "dot"); return; }
    if (s.task === "working") {
      var act = (s.items || []).filter(function (i) { return i.status === "active"; });
      setPill(act.length ? act[act.length - 1].text : "Working…", "spin");
    } else if (s.task === "complete" && s.note) {
      setPill(s.note, "check", true);
    } else if (s.task === "error") {
      setPill("Hit an error" + (s.note ? ": " + s.note : ""), "err");
    } else {
      setPill(s.computer === "stopped" ? "Session ended" : "Maritime · live", "dot");
    }
  } catch {}
}, 3000);

checkAccess().then(function (ok) { if (ok) loadViewer(true); });
</script>
</body>
</html>`;
}

// ---------- http ----------
const pings: Record<string, number> = {};
const pauseFlags: Record<string, boolean> = {};
const runner = new TaskRunner({
  seed: store.sites ?? {},
  onChange: (ref, s) => {
    (store.sites ??= {})[ref] = s;
    saveStore();
  },
});

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

// Who the Keiki agent is talking to. Keiki passes the sender identity on
// webhook tool calls (header + context fields); accept every known spelling
// and log the envelope once so a new shape is easy to spot.
function callerId(req: IncomingMessage, body: any): string {
  const h = req.headers["x-orchid-user-id"] ?? req.headers["x-orchid-userid"];
  const c =
    (Array.isArray(h) ? h[0] : h) ??
    body?.context?.userId ??
    body?.userId ??
    body?.context?.phone ??
    body?.phone ??
    body?.sender?.id ??
    "unknown";
  return String(c);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    if (url.pathname === "/healthz") return json(res, 200, { ok: true });

    if (url.pathname === "/") {
      res.writeHead(302, { location: "/designs/" });
      return res.end();
    }

    if (url.pathname === "/demo-site") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Harbor Coffee</title>
<style>body{margin:0;background:#0a1a2f;color:#f4ead8;font-family:Georgia,serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh}
h1{font-size:48px;margin:0 0 8px}p{color:#c8a97e;font-size:20px}.tag{letter-spacing:4px;text-transform:uppercase;font-size:12px;color:#7f95ad}</style></head>
<body><div class="tag">est. 2026 · built inside imessage</div><h1>Harbor Coffee</h1><p>Small-batch roasts. Open dawn to dusk.</p></body></html>`);
    }

    if (url.pathname === "/static/novnc-rfb.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600" });
      return res.end(novncBundle());
    }

    // ---------- design lab: static mockups of the mini app ----------
    // /designs/ -> index.html gallery; /designs/design.html?d=N&scene=S -> one card
    const dm = url.pathname.match(/^\/designs(?:\/(.*))?$/);
    if (dm) {
      const rel = (dm[1] || "index.html") || "index.html";
      if (rel.includes("..")) return json(res, 400, { error: "path" });
      const CT: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      };
      const ext = rel.slice(rel.lastIndexOf("."));
      try {
        const body = readFileSync(join(__dirname, "..", "designs", rel));
        res.writeHead(200, { "content-type": CT[ext] ?? "application/octet-stream", "cache-control": "no-store" });
        return res.end(body);
      } catch {
        return json(res, 404, { error: "not found" });
      }
    }

    // ---------- keiki agent tools ----------
    // POST /k/<KEIKI_TOOL_SECRET>/<open|task|pair|cancel|state>
    const k = url.pathname.match(/^\/k\/([^/]+)\/(open|interactive|task|pair|cancel|state)$/);
    if (k) {
      if (req.method !== "POST") return json(res, 405, { error: "method" });
      if (k[1] !== TOOL_KEY) return json(res, 403, { error: "bad key" });
      const body = await readBody(req);
      const userId = callerId(req, body);
      console.log(`keiki tool ${k[2]} for ${userId}`, JSON.stringify(body).slice(0, 400));
      const b = bindingForUser(userId, "keiki");

      if (k[2] === "open" || k[2] === "interactive") {
        const live = k[2] === "open";
        // live:false opens the interactive sheet — tag the URL so the shell
        // switches to the control-first layout (header on top, keyboard below)
        const cardUrl = `${PUBLIC_ORIGIN}/vm/${b.ref}${live ? "" : "?view=sheet"}`;
        // warm the computer in the background so the first frame is fast
        ensureComputer(b).then(
          (c) => console.log(`computer ${c.id} status=${c.status}`),
          (e) => console.error("ensureComputer failed", e),
        );
        return json(res, 200, {
          status: "ok",
          url: cardUrl,
          presentation: {
            type: "app",
            id: `${live ? "open" : "sheet"}-${b.ref}-${randomBytes(4).toString("hex")}`,
            url: cardUrl,
            // Keiki renders live:true inline in the transcript — a live
            // mini app whose view is non-interactive by Keiki design;
            // live:false gives a tappable bubble that opens the
            // interactive sheet, where every control works
            live,
            caption: "Maritime Computer",
            subcaption: live ? "Your live cloud desktop" : "Tap to take control",
          },
        });
      }
      if (k[2] === "task") {
        const text = String(body?.text ?? body?.task ?? "").trim();
        if (!text) return json(res, 400, { status: "error", error: "text required" });
        runner
          .run(b.ref, () => ensureComputer(b), text)
          .then((note) => console.log(`task done for ${userId}: ${note}`))
          .catch((e) => console.error(`task failed for ${userId}:`, e));
        return json(res, 202, { status: "ok", accepted: true });
      }
      if (k[2] === "pair") {
        let code = String(body?.code ?? "").trim();
        const refs = ownedRefs(userId);
        if (code === "" || code.toLowerCase() === "latest") {
          // approve whatever fresh pending code the viewer is showing now
          const pending = Object.values(store.challenges)
            .filter((c) => refs.includes(c.ref) && c.status === "pending")
            .sort((a, z) => z.createdAt.localeCompare(a.createdAt))[0];
          code = pending?.code ?? "";
        }
        if (!code) return json(res, 400, { status: "error", error: "code required" });
        const ok = refs.some((r) => approveChallenge(store, code, r));
        saveStore();
        console.log(`  pairing ${code} ${ok ? "approved" : "rejected"} for ${b.ref}`);
        return json(res, 200, { status: ok ? "ok" : "rejected", ok });
      }
      if (k[2] === "cancel") {
        const n = runner.cancelPending(b.ref);
        return json(res, 200, { status: "ok", cancelled: n });
      }
      const c = b.computerId ? await getComputer(b.computerId) : null;
      const t = runner.stateFor(b.ref);
      return json(res, 200, {
        status: "ok",
        computer: c?.status ?? "none",
        task: t.state,
        note: t.note,
        items: t.items,
      });
    }

    // localhost-only dev hook: simulate the iMessage "connect <code>" path
    if (url.pathname === "/dev/pair-approve" && req.method === "POST") {
      const remote = req.socket.remoteAddress ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return json(res, 403, { error: "localhost only" });
      const body = await readBody(req);
      const refs = ownedRefs(String(body?.userId ?? ""));
      const ok = refs.some((r) => approveChallenge(store, String(body?.code ?? ""), r));
      saveStore();
      return json(res, ok ? 200 : 403, { ok });
    }

    // localhost-only dev hook: get-or-create a channel-scoped binding
    if (url.pathname === "/dev/binding" && req.method === "POST") {
      const remote = req.socket.remoteAddress ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return json(res, 403, { error: "localhost only" });
      const body = await readBody(req);
      const b = bindingForUser(String(body?.userId ?? ""), String(body?.channel ?? "keiki"));
      return json(res, 200, { ref: b.ref });
    }

    const m = url.pathname.match(/^\/vm\/([A-Za-z0-9_]+)(\/viewer|\/ping|\/state|\/pause|\/stop|\/task|\/task\/cancel|\/type|\/pair\/start|\/pair\/status|\/diag)?$/);
    if (m) {
      const b = store.bindings[m[1]];
      if (!b) return json(res, 404, { error: "unknown reference" });
      if (m[2] && m[2] !== "/state" && m[2] !== "/pair/status") console.log(`${req.method} /vm/${b.ref}${m[2]}`);
      if (!m[2]) {
        // Safe for crawlers: static shell only, no computer ops.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page(b));
      }

      // pairing handshake endpoints — open by design. GET allowed because
      // some host webviews swallow POST bodies; the op is minting a
      // short-lived code only, so the method is not security-bearing.
      if (m[2] === "/pair/start" && (req.method === "POST" || req.method === "GET")) {
        const body = req.method === "POST" ? await readBody(req) : null;
        const forceNew = url.searchParams.get("fresh") === "1" || body?.fresh === true;
        console.log(`pair/start for ${b.ref} via ${req.method}${forceNew ? " fresh" : ""}`);
        const ch = createChallenge(store, b.ref, forceNew);
        saveStore();
        return json(res, 200, { code: ch.code });
      }
      if (m[2] === "/pair/status") {
        const code = String(url.searchParams.get("code") ?? "");
        const st = challengeStatus(store, code);
        if (st === "approved") {
          const s = exchangeChallenge(store, code);
          saveStore();
          if (s) return json(res, 200, { status: "approved", session: s.token });
        }
        return json(res, 200, { status: st });
      }
      // tap diagnostic beacon — GET only, proves whether the host webview
      // delivers gestures to the page at all
      if (m[2] === "/diag") {
        console.log(`diag ${b.ref} ev=${url.searchParams.get("ev")} x=${url.searchParams.get("x")} y=${url.searchParams.get("y")}`);
        return json(res, 200, { ok: true });
      }

      // everything below proves ownership when pairing is on
      if (PAIRING) {
        const ref = sessionRef(store, req.headers["x-session"] as string | undefined);
        if (ref !== b.ref) return json(res, 401, { error: "pairing required" });
      }

      if (m[2] === "/viewer" && req.method === "POST") {
        const body = await readBody(req);
        const c = await ensureComputer(b);
        const want = body?.mode === "control" ? "control" : "watch";
        if (want === "watch" && b.controlToken) {
          // releasing control: hand the desktop back to the agent, otherwise it
          // stays `human` server-side and every action 409s until the grant TTL
          await takeoverComplete(c.id, b.controlToken, true, "released from mini app")
            .catch((e) => console.warn("takeover release failed:", e));
          b.controlToken = undefined;
          saveStore();
        }
        const grant = await createViewer(c.id, want);
        const t = new URL(grant.url).searchParams.get("t") ?? "";
        if (want === "control") {
          b.controlToken = t || undefined;
          saveStore();
        }
        // our page speaks RFB directly — the grant token authenticates the raw
        // websocket, so their viewer page/chrome never enters the picture
        const wsBase = (process.env.MARITIME_API_URL ?? "https://api.maritime.sh").replace(/^http/, "ws");
        const wsUrl = `${wsBase}/api/v1/computers/${c.id}/viewer-ws?t=${encodeURIComponent(t)}`;
        return json(res, 200, { url: grant.url, wsUrl, expiresAt: grant.expiresAt, status: c.status, mode: grant.mode });
      }
      if (m[2] === "/ping" && req.method === "POST") {
        pings[b.ref] = (pings[b.ref] ?? 0) + 1;
        return json(res, 200, { pings: pings[b.ref] });
      }
      if (m[2] === "/pause" && req.method === "POST") {
        const body = await readBody(req);
        pauseFlags[b.ref] = Boolean(body?.paused);
        return json(res, 200, { paused: pauseFlags[b.ref] });
      }
      if (m[2] === "/stop" && req.method === "POST") {
        if (b.computerId) await closeSession(b.computerId).catch(() => {});
        return json(res, 200, { stopped: true });
      }
      if (m[2] === "/task" && req.method === "POST") {
        const body = await readBody(req);
        const text = String(body?.text ?? "").trim();
        if (!text) return json(res, 400, { error: "text required" });
        runner
          .run(b.ref, () => ensureComputer(b), text)
          .then((note) => console.log(`task done for ${b.ref}: ${note}`))
          .catch((e) => console.error(`task failed for ${b.ref}:`, e));
        return json(res, 202, { accepted: true });
      }
      if (m[2] === "/task/cancel" && req.method === "POST") {
        const n = runner.cancelPending(b.ref);
        return json(res, 200, { cancelled: n });
      }
      // live typing from the sheet keyboard — watch-mode path (control mode
      // sends keysyms over the RFB socket instead). ops preserve order:
      // {del:n} backspaces, {key:"Return"} keys, {text:"…"} types, \n = Return
      if (m[2] === "/type" && req.method === "POST") {
        const body = await readBody(req);
        const ops: any[] = Array.isArray(body?.ops)
          ? body.ops
          : [{ del: Number(body?.del) || 0 }, { text: body?.text }, ...(body?.enter ? [{ key: "Return" }] : [])];
        if (!ops.some((o) => (Number(o?.del) || 0) > 0 || String(o?.text ?? "") !== "" || o?.key)) {
          return json(res, 400, { error: "nothing to type" });
        }
        const c = await ensureComputer(b);
        for (const op of ops) {
          for (let i = Math.min(Number(op?.del) || 0, 200); i > 0; i--) {
            await desktopAction(c.id, { action: "key", text: "BackSpace", no_screenshot: true });
          }
          const segs = String(op?.text ?? "").split(/[\r\n]+/);
          for (let i = 0; i < segs.length; i++) {
            if (i > 0) await desktopAction(c.id, { action: "key", text: "Return", no_screenshot: true });
            if (segs[i]) await desktopAction(c.id, { action: "type", text: segs[i], no_screenshot: true });
          }
          if (op?.key) await desktopAction(c.id, { action: "key", text: String(op.key).slice(0, 40), no_screenshot: true });
        }
        return json(res, 200, { ok: true });
      }
      if (m[2] === "/state") {
        const c = b.computerId ? await getComputer(b.computerId) : null;
        const t = runner.stateFor(b.ref);
        return json(res, 200, {
          computer: c?.status ?? "none",
          mode: c?.mode ?? "agent",
          paused: pauseFlags[b.ref] ?? false,
          pings: pings[b.ref] ?? 0,
          task: t.state,
          note: t.note,
          items: t.items,
        });
      }
      return json(res, 405, { error: "method" });
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (e) {
    console.error("http error", e);
    json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, () => console.log(`mini app origin on :${PORT} (public: ${PUBLIC_ORIGIN})`));

process.on("SIGINT", () => process.exit(0));
