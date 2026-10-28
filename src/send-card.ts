/**
 * One-off: proactively send the live mini-app card to a registered user.
 * Usage: npx tsx src/send-card.ts <E.164 phone>
 */
import { Spectrum, app as appCard, edit } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

const phone = process.argv[2];
if (!phone) {
  console.error("usage: tsx src/send-card.ts <E.164 phone> [ref] [sheet]");
  process.exit(1);
}
// "sheet" in either arg position sends the interactive (live:false) bubble
// that opens the sheet layout — top header + typing keyboard
const live = process.argv[3] !== "sheet" && process.argv[4] !== "sheet";

const ORIGIN = process.env.PUBLIC_ORIGIN!;
// resolve the photon-scoped binding (its own ref + computer) unless a ref is given
const ref = (process.argv[3] !== "sheet" && process.argv[3]) || (await (
  await fetch("http://localhost:8787/dev/binding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: phone, channel: "photon" }),
  })
).json() as { ref: string }).ref;
const url = `${ORIGIN}/vm/${ref}${live ? "" : "?view=sheet"}`;

const spectrum = await Spectrum({ providers: [imessage.config()] });
const im = imessage(spectrum);

const user = await im.user(phone);
const space = await im.space.create(user);

console.log(`sending ${live ? "live" : "sheet"} card -> ${url}`);
const card = await space.send(appCard(url, { live }));
console.log("card sent:", JSON.stringify(card, null, 2).slice(0, 800));

await space.send(live ? "your maritime computer is live in the card above — tap to expand." : "tap the card above to open your maritime computer — controls on top, keyboard at the bottom.");

// wait a moment for delivery telemetry, then stop
await new Promise((r) => setTimeout(r, 3000));
await spectrum.stop();
process.exit(0);
