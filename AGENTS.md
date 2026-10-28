# photonlivemini

Maritime cloud computers inside iMessage, delivered as Photon live app cards.
One Node/TypeScript service: Keiki-facing tool webhooks plus the HTTPS mini-app
origin that renders a live noVNC view of each user's dedicated Maritime
computer. See `docs/FEASIBILITY.md` for verified API behaviors — read it before
changing Maritime or Spectrum calls.

## Requirements

- Node.js 20+ (TypeScript runs directly via `tsx` — there is no build step)
- npm

## Setup

```sh
npm install
```

`.env` is included in this export with live credentials. If you need to
recreate it, the variables are:

| Var | Purpose |
|---|---|
| `MARITIME_TOKEN` | Maritime API key (`mk_…`) — required by `src/maritime.ts` |
| `MARITIME_API_URL` | Maritime base URL, defaults to `https://api.maritime.sh` |
| `PUBLIC_ORIGIN` | Public HTTPS origin of this service (e.g. a cloudflared/named-tunnel URL). Required for real use — iMessage cards load `/vm/<ref>` from it. Defaults to `http://localhost:PORT` |
| `PORT` | Listen port, default `8787` |
| `KEIKI_TOOL_SECRET` | Path key for Keiki tool webhooks: `POST /k/<KEIKI_TOOL_SECRET>/<open|task|pair|cancel|state>` |
| `PAIRING_REQUIRED` | Set `false` to disable ownership pairing (default: on) |
| `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `PHOTON_PROJECT_ID`, `KEIKI_API_KEY`, `KEIKI_BASE_URL` | Photon Spectrum / Keiki credentials consumed by `spectrum-ts` and `src/send-card.ts` |

## Run

```sh
npm run dev        # watch mode
npm start          # single run
npm run typecheck  # tsc --noEmit — run this to verify changes
```

Server listens on `:8787`. For the card to render in iMessage the origin must
be public HTTPS — dev used `cloudflared` quick tunnels (`cloudflared tunnel
--url http://localhost:8787`), then set `PUBLIC_ORIGIN` to the tunnel URL.
Quick-tunnel URLs are ephemeral; a restart means new `PUBLIC_ORIGIN` and old
cards go dead.

## Layout

- `src/server.ts` — HTTP server: mini-app shell `/vm/<ref>`, Keiki tool
  webhooks `/k/<key>/*`, viewer/task/state/pairing endpoints, WebSocket proxy
  to the Maritime VNC stream. `/vm/<ref>?view=sheet` (sent on `live:false`
  interactive cards) switches the shell to the control-first layout — pill +
  buttons as a top header, bottom keyboard bar typing into the VM (`/type`
  REST action in watch mode, noVNC `sendKey` over RFB in control mode)
- `src/maritime.ts` — Maritime Computers REST adapter (computers, viewer
  grants, desktop actions, exec, file read/write)
- `src/tasks.ts` — task runner: instruction text → mutate SiteSpec → write
  page onto the computer → open/reload it in Chromium
- `src/site.ts` — deterministic site builder (stand-in for a real agent
  harness)
- `src/pair.ts` — ownership pairing: viewer gets a code, owner texts
  `connect <code>` in the iMessage thread, browser exchanges it once
- `src/send-card.ts` — one-off: `npx tsx src/send-card.ts <E.164 phone> [ref]`
  proactively sends a live card
- `static/novnc-rfb.js` — bundled noVNC RFB client served to the mini app
- `data/store.json` — runtime persistence (bindings, pairing, site specs);
  `vm_testlocal1` is the seeded test binding
- `scripts/test-pairing.mjs`, `scripts/test-viewer.mjs` — smoke tests against
  a running server
- `docs/KEIKI.md` — Keiki vs Photon card-interactivity investigation: Keiki's
  `live:true` card does not deliver DOM gestures (non-interactive by host
  design); use the `interactive` presentation for user input

## Gotchas

- ESM (`"type": "module"`), strict TS. Local imports use `.js` extensions.
- Maritime `exec` has **no X display** — GUI navigation goes through the
  actions API (click omnibox → type URL → Return), not exec. See the header
  comment in `src/tasks.ts`.
- Viewer grants expire (~10 min TTL); the shell refreshes them — don't cache
  `?t=` tokens.
- File writes 404 if the parent dir doesn't exist on the computer —
  `mkdir -p` via exec first.

## Design lab (`designs/`)

115 candidate skins for the mini-app card, browsable at `/designs/` (also
file://). `designs/index.html` is the gallery; `design.html?d=N&scene=S`
renders one card in one state; `base.css`+`shared.js` mirror `page()`'s DOM
1:1 so a winning skin ports as a CSS block into `src/server.ts`. Keiki brand
tokens (kumo system, palette, pixel icons) are noted in `designs/README.md`.
`node scripts/shoot-designs.mjs` regenerates screenshots into `designs/shots/`.
