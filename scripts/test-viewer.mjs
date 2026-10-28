// Feasibility: does the Maritime viewer render inside our iframe shell?
// Loads the mini app page over the public tunnel, watches console/network,
// exercises the new controls, and screenshots what a mini-app webview sees.
import { chromium } from "playwright";

const ORIGIN = process.env.PUBLIC_ORIGIN ?? "https://databases-lakes-critical-consolidation.trycloudflare.com";
const ref = process.argv[2] ?? "vm_testlocal1";
const url = `${ORIGIN}/vm/${ref}`;

const browser = await chromium.launch();
// iPhone-ish compact view
const page = await browser.newPage({ viewport: { width: 390, height: 700 } });

const consoleMsgs = [];
page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
const failed = [];
page.on("requestfailed", (r) => failed.push(`${r.url()} :: ${r.failure()?.errorText}`));

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(12000);

const state = await page.textContent("#state");
const tick = await page.textContent("#tick");
const frame = page.frames().find((f) => f.url().includes("maritime.sh"));
const veilHidden = await page.$eval("#veil", (el) => el.classList.contains("hide"));

// exercise Take control -> control-mode grant
await page.click("#modeControl");
await page.waitForTimeout(9000);
const stateAfterControl = await page.textContent("#state");
const frameAfter = page.frames().find((f) => f.url().includes("maritime.sh"));
const controlUrl = frameAfter?.url() ?? "";
const isControl = controlUrl.includes(".control.");

await page.screenshot({ path: "/tmp/miniapp-v2.png", fullPage: false });

// compact height (inline card size)
await page.setViewportSize({ width: 390, height: 340 });
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/miniapp-v2-compact.png" });

console.log(JSON.stringify({
  url, state, tick, veilHidden,
  maritimeFrameLoaded: Boolean(frame),
  stateAfterControl, isControlMode: isControl,
  controlUrl: controlUrl.slice(0, 90),
  failedRequests: failed,
  console: consoleMsgs.slice(0, 20),
}, null, 2));

await browser.close();
