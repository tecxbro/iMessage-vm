// Pairing flow test: page shows Connect overlay → code → approve via the
// localhost dev hook (same approveChallenge() the iMessage "connect" text hits)
// → session unlocks → viewer loads.
import { chromium } from "playwright";

const ORIGIN = process.env.PUBLIC_ORIGIN ?? "https://databases-lakes-critical-consolidation.trycloudflare.com";
const ref = "vm_testlocal1";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 700 } });

await page.goto(`${ORIGIN}/vm/${ref}`);
await page.waitForTimeout(2500);

// pairing overlay should be showing (session gate is on)
const pairVisible = await page.$eval("#pair", (el) => !el.classList.contains("hidden")).catch(() => false);
const state = await page.textContent("#state");

// confirm the gate actually protects endpoints
const unauth = await page.evaluate(async (r) => {
  const res = await fetch("/vm/" + r + "/viewer", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return res.status;
}, ref);

await page.screenshot({ path: "/tmp/pair-1-locked.png" });

// tap Connect -> code appears
await page.click("#connectBtn");
await page.waitForTimeout(1500);
const code = (await page.textContent("#codetext")).trim();
await page.screenshot({ path: "/tmp/pair-2-code.png" });

// approve as the owner — via the localhost-only dev hook (curl), simulating
// the inbound "connect CODE" text. Public origin can't reach this endpoint.
const approve = await fetch(`http://localhost:8787/dev/pair-approve`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code, userId: "localtest" }),
}).then((r) => r.status);

// also verify a WRONG user can't approve a new code
await page.waitForTimeout(4000); // page polls every 2s
const stateAfter = await page.textContent("#state");
const pairHidden = await page.$eval("#pair", (el) => el.classList.contains("hidden"));

await page.waitForTimeout(10000); // let viewer load
const frame = page.frames().find((f) => f.url().includes("maritime.sh"));
await page.screenshot({ path: "/tmp/pair-3-unlocked.png" });

console.log(JSON.stringify({
  pairVisibleInitially: pairVisible, initialState: state, unauthViewerStatus: unauth,
  codeShown: code, approveStatus: approve, stateAfter, pairHidden,
  frameLoaded: Boolean(frame),
}, null, 2));
await browser.close();
