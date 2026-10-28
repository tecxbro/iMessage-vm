# Keiki migration — the click-registration issue

Date: 2026-10-26. Verdict from a live A/B on the same page, same URL, same iPhone.

## Symptom

After swapping the card transport from Photon/Spectrum to Keiki (`presentation {type:"app", live:true}`), the mini app rendered and updated inside iMessage but **no tap ever registered**: Connect, New code, veil, task list — all dead inside the Keiki Vault card. The same taps worked in Photon (Spectrum extension), Chrome on Mac, and Playwright WebKit.

## Evidence

- Tap beacon (`GET /vm/<ref>/diag?ev=…`) added to the page on `touchstart`/`click`.
- Photon card on iPhone: beacons + `POST /pair/start` fired on every tap → click path proven end-to-end.
- Keiki card on iPhone, tapped repeatedly for ~20 s (log marker): **zero** beacons, while the same live view successfully ran `POST /pair/start` (auto-mint), `GET /state` polls, and `POST /viewer`. Requests flow; DOM gestures never arrive.
- Earlier `POST /pair/start` hits from "the card" were actually the user's **Mac** — confirmed by the user.

## Root cause — same `live` flag, opposite semantics

**Photon / Spectrum** — `photon.codes/docs/spectrum-ts/content/app.md`:

> "Set `live` to `true` to request live rendering … `live` is a rendering hint. The recipient needs a supported platform and the corresponding app extension for its live UI to appear."
> "On iMessage, app cards open inside the Spectrum iMessage App, an iMessage App launcher approved by Apple."

and `…/providers/imessage/messaging-features/apps.md`:

> "Set `live: true` when you want Messages to render the installed extension's live UI instead of only showing the static layout preview."

Send: `space.send(app(url, { live: true }))` → `customized-mini-app` payload → hosted by Spectrum's MessagesExtension (`codes.photon.Spectrum.MessagesExtension`). The extension's "live UI" is a real webview — observed: every tap/click on the card reaches page DOM events.

**Keiki Vault** — `onkeiki.com/docs/keiki-vault.md` ("How it renders"):

> "Tapping the bubble opens the card expanded and loads `url` in a web view. … `live: true` draws the page in the transcript bubble itself. **Transcript views are not interactive**, and a tap does not open the expanded card, so keep `live` off for any page with buttons or forms."

Send: `presentation { type: "app", url, live: true }` (or builtin `imessage_send_app`) → hosted by Keiki Vault (`com.keiki.vault.messages`). The transcript view runs JS and network requests but forwards zero DOM gestures — observed: 20 s of tapping produced no `touchstart`/`click` events while the page's own fetches flowed.

So `live: true` means "interactive live mini app" on Photon and "non-interactive inline rendering" on Keiki. Keiki's only interactive surface is `live: false` → tappable bubble → expanded sheet (the same web view Photon's card gives you). There is no flag to change it — Keiki's `presentation` schema is only `type/id/url/live/caption/subcaption` (`onkeiki.com/docs/imessage-apps.md`).

## Secondary bugs found while chasing it

- `createChallenge` deduped: `pair/start` returned the **same** pending code while valid, so "New code" clicks produced no visible change — looked like dead clicks even where they worked. Fixed: `{fresh:true}`/`?fresh=1` mints a new code and expires prior pendings (`src/pair.ts`).
- Cloudflare quick tunnel died mid-testing → stale cards pointed at a dead origin and looked broken for a different reason. New origin must be re-registered in the Keiki tool webhooks (`webhook_url` is immutable via PATCH — delete + recreate the tool).

## Resolution

Two-card model matching Keiki's two surfaces:

| Card | Flag | Behavior |
|---|---|---|
| `open_computer` → `/k/<key>/open` | `live: true` | live desktop inline in transcript — watch-only |
| `open_interactive_computer` → `/k/<key>/interactive` | `live: false` | tappable bubble → expanded interactive sheet, all controls work |

Page made tap-free for the live view: auto-mint pairing code on gate, auto-remint on expiry, auto-reconnect on session end. Pairing approval is cross-channel: `connect <code>` texted to the Keiki line approves whichever owned ref shows it (`ownedRefs` in `src/server.ts`).

Channel-scoped bindings: `byUser` keys are `<channel>:<userId>`; Keiki (`vm_26bf…` → `ee7bb230`) and Photon (`vm_88ef…` → `46927691`) own separate Maritime computers. Legacy unscoped keys migrate to `keiki:` at boot.
