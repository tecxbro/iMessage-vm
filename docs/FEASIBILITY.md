# Feasibility — Maritime viewer inside a Photon live mini app

Date: 2026-10-26. Environment: macOS dev machine, Spectrum `spectrum-ts@12.14.0`, Photon project **grokbot** (`ca8e99f1-d80b-43c0-a197-c20e0e4770b3`, free plan, shared iMessage line `+14156055838`), Maritime API `https://api.maritime.sh`.

## Verified so far (server-side)

| Check | Result |
|---|---|
| `maritime` CLI login | Logged in as darshangolchha2@gmail.com (login token, exp 2026-11-25). Long-lived `mk_…` key minted for REST. |
| `photon` CLI login | Device-flow login as golchhad@uci.edu; active project `grokbot`. |
| `POST /api/v1/computers` | Created Linux x86_64 computer `8580dd6a-c091-4d9c-83fc-ca70e47e6a43`, `externalUserId=photonlivemini-test`, status `ready`, screen 1280×800. Cold create ~5.2s (`lastWakeMs`, `lastWakeMethod:"golden"`). |
| `GET …/screenshot` | PNG of a real desktop (Chromium on about:blank, taskbar clock). Confirms a live machine, not a stub. |
| `POST …/viewer` | Returns `{url, expiresAt, mode:"watch"}`. Grant TTL ≈ 10 min. URL shape: `https://maritime.sh/computer/<id>?t=cv1.<id>.<ts>.watch.<…>`. |
| Viewer framing headers | No `X-Frame-Options`, no CSP `frame-ancestors` on `maritime.sh/computer/*` → iframe embedding is not blocked by headers. |
| `app(url,{live:true})` send | Accepted by cloud iMessage provider. Returned message carries `miniAppCardSession` `{chatGuid,messageGuid,sessionId,targetMessageGuid}` and `customized-mini-app` content with Spectrum extension identity (`codes.photon.Spectrum.MessagesExtension`, teamId `P8XT6232SL`, appStoreId `6777616651`). Card caption/subcaption auto-derived from our page `<title>`/`og:` tags. |
| Mini-app origin over public HTTPS | `cloudflared` quick tunnel serving the shell at `/vm/<ref>`; `/viewer` POST returns fresh grant; `/ping` and `/state` work end-to-end through the tunnel. |
| `POST …/actions` (REST) | `{action:"left_click"|"type"|"key",…}` works. Response is JSON with `imageB64` post-action frame (`format:"png"` default PNG on REST; `no_screenshot:true` skips it). Typed text into Chromium omnibox + `Return` navigated successfully. |
| Unique visible change | Navigated the computer's Chromium to `/demo-site` on our own tunnel origin; screenshot confirms the navy "Harbor Coffee" page rendered. Full loop: our backend → REST action → real desktop change → screenshot verify. |
| Gotcha | A `data:text/html,<body style=…>` payload typed into the omnibox arrived mangled (`chrome://data/html…`, ERR_INVALID_URL). Typing real URLs works; for arbitrary content prefer `write_file`/shell or a served page. |

| Webview render test (Playwright, 390×700) | **Embedded mode works.** Our shell at `/vm/<ref>` loads Maritime's viewer in an iframe: header "Computer 8580dd6a ● Connected / Watching" and the live desktop (navy Harbor Coffee page) render inside the frame. Ping button round-trips. No console errors, no failed requests. Evidence: `docs/assets/miniapp-webview-embedded-viewer.png`, `docs/assets/maritime-desktop-harbor-coffee.png`. |
| Viewer `control` mode | `POST …/viewer {mode:"control"}` returns a grant with `.control.` token. Loading it flips the computer to `mode:"human"` and Maritime's viewer supplies its own takeover chrome ("You are in control", optional note, **Done**/**Failed** handback buttons) — P1 human takeover is effectively built-in. |
| `edit()` in-place | `space.send(edit(app(url,{live:true}), originalCard))` accepted, returns `undefined` per contract. Render confirmation pending on device. |
| Inbound → card → per-user computer | A real inbound iMessage (`+1XXXXXXXXXX`: "yeah you may stop") reached the Spectrum loop, deduped (`spc-msg-c3ac2fdc`), created binding `vm_26bf2cc3115762ba9baecf`, sent a live card, and provisioned a dedicated computer `ee7bb230-…` (`externalUserId=imessage-+1XXXXXXXXXX`, ready in 2.4s). Persistent per-user computer ownership works. |

## Pending device observations (need real iPhone)

- [ ] Does the inline card render the page (counter ticking) without tapping?
- [ ] Does expanded view show the Maritime desktop inside Messages?
- [ ] Does the Ping button round-trip work inside the extension webview?
- [ ] iframe viewer vs top-level navigation — which mode actually renders?
- [ ] 60s+ continuous viewing; leave/return to Messages; network loss; viewer-grant expiry refresh.
- [ ] `edit()` in-place card update renders correctly.

## Task path (deterministic stand-in for the harness)

| Check | Result |
|---|---|
| `POST /api/v1/computers/{id}/exec` | Runs a shell command as `desk` (cwd `/data`), `{command, timeoutS≤30}` → `{exitCode, stdout, stderr}`. **No X display** — cannot launch/activate GUI windows; use it for fs/process ops only. |
| `PUT/GET …/files?path=` | Octet-stream body write → 204; GET returns bytes. **404 "No such computer" when the parent dir doesn't exist** — `mkdir -p` via exec first. |
| GUI navigation | `exec` can't reach X; the actions API drives Chromium: click omnibox → type `file://…` → `Return`, `F5` to reload. Proven. |
| Task flow | `POST /vm/<ref>/task {text}` → mutate persisted `SiteSpec` → write `/home/desk/site/index.html` → open/reload in Chromium. Screenshots confirm build + follow-up ("add a menu", "add a contact section") render on the same page. |
| Spec persistence | SiteSpec + `siteOpened` persist in `data/store.json`; a follow-up after backend restart modifies the same page (PRD restart criterion). |
| Takeover handback | `takeover/complete` exists; natural grant **expiry also returns mode to `agent`** (verified: `human` → `agent` at expiresAt). Actions/screenshot refuse with `human_in_control` + `retryAfterS` while held. |

## Ownership pairing (PRD §7) — implemented + validated

| Check | Result |
|---|---|
| Unauthenticated access | `/viewer`, `/task`, `/state`, `/pause`, `/stop`, `/ping` all return **401** without a session (`PAIRING_REQUIRED` env, default on). Page shell stays public and touches no computer state. |
| Connect flow | Connect → `POST /pair/start` → 6-char code → owner texts `connect <code>` → `approveChallenge` requires the texter's own binding to map to the same ref → browser polls `/pair/status` → one-shot exchange → `ps_…` session in localStorage, `x-session` header onward. |
| Forwarding protection | A code minted for ref A can never be approved by a texter whose binding is ref B (hard ref equality). Dev-only `POST /dev/pair-approve` is loopback-restricted for testing. |
| Validated | Playwright: locked overlay → code → localhost approve → unlock → viewer frame loads. Sessions persist across server restarts (`x-session` still 200 after restart; bogus token still 401). Screenshots `docs/assets/pair-*.png` (code screen + unlocked desktop). |

## Known limitations

- Quick tunnel URL is ephemeral — restart changes `PUBLIC_ORIGIN`; cards sent earlier point at dead origins. Use a named tunnel or deployed host for the real demo.
- `/vm/<ref>` is unauthenticated (milestone 1). Pairing flow per PRD §7 comes after the viewing mode is proven.
- Viewer grants are `watch` mode; `control` mode untested.
- grokbot is free plan → shared pool line; proactive sends require registered/opted-in project users.
