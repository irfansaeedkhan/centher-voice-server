# Centher Voice Server

Standalone voice/video backend for Centher's VoiSpace rooms:
**socket.io** signaling + **mediasoup** SFU, speaking exactly the protocol
the web app's hooks expect (`hooks/stream/use.ama.ts`, `use.live.ts`).

The web app (https://centher-app.vercel.app) can't host this itself —
Vercel serverless has no persistent sockets or UDP media ports — so it runs
as its own service (Oracle Cloud Always Free, $0) and the app points
`NEXT_PUBLIC_GQL_URL_WEBSOCKET` at it.

## Quick start (local dev)

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL at minimum
npm run build
npm start
# or: npm run dev (watch mode via vitest? no — dev uses ts-node; see package.json)
```

Health check: `curl http://localhost:3001/health`

> Local dev note: browsers need a reachable `MEDIASOUP_ANNOUNCED_IP` for
> real media; for protocol-only testing, two tabs on `localhost:3000`
> with `ALLOWED_ORIGINS=http://localhost:3000` is enough to create/join
> rooms (media will fail ICE without a public IP — expected).

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Boot: env validation → mediasoup → listen → graceful shutdown |
| `src/server.ts` | HTTP + socket.io wiring, CORS allowlist, Bearer auth, `/health` |
| `src/handlers.ts` | The wire protocol: every client emit → server action |
| `src/rooms.ts` | Room state machine (pure, fully tested) |
| `src/mediasoup.ts` | Worker/router/transport management (one Router per room, round-robin workers) |
| `src/auth.ts` | Bearer session-token → read-only Better Auth `session` lookup on Neon |
| `src/config.ts` | Env config + fail-fast validation |
| `tests/` | 35 tests: rooms, auth, full protocol (mocked mediasoup) |

## Docs

- [`PROTOCOL.md`](PROTOCOL.md) — the complete client↔server wire contract,
  including the `rtpCapabilities` ack compat shim both hooks need.
- [`DEPLOY.md`](DEPLOY.md) — Oracle Cloud Always Free deploy, step by step
  (VM → firewall → Docker → Caddy HTTPS → Vercel env var).

## Commands

```bash
npm test          # vitest, 35 tests
npm run typecheck # tsc --noEmit
npm run format:check
npm run build && npm start
```

## Security notes

- Auth is fail-closed: no/invalid/expired Bearer token → socket rejected.
- Owner-only actions (kick, talk/messaging permission, invite) are enforced
  server-side from the authenticated user id — never a client-supplied id.
- No secrets in the repo; `.env.example` holds placeholders only.
- The DB connection is used read-only (session lookups); use the
  non-pooled Neon string.
