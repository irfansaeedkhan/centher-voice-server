# Centher Voice Server — Wire Protocol

The contract between the web app's VoiSpace hooks
(`hooks/stream/use.ama.ts`, `hooks/stream/use.live.ts`,
`stream/clients/socket-client.ts` in `centher.dashboard.fullstack`)
and this server. Transport: **socket.io** (the client starts with
long-polling and upgrades to WebSocket).

## 1. Connection & auth

- The client connects to `NEXT_PUBLIC_GQL_URL_WEBSOCKET` and sends
  `Authorization: Bearer <token>` in the polling transport's
  `extraHeaders`.
- The token is a **short-lived voice JWT** minted by the web app
  (`GET /api/voice/token`, Better Auth session required). Locked contract:
  HS256, secret = `AUTH_JWT_SECRET` (must equal the app's
  `BETTER_AUTH_SECRET`), payload
  `{ sub: <userId>, aud: "centher-voice", iat, exp: now+15min }`.
  The server verifies signature + audience + expiry with `jose`,
  fail-closed.
- On success the server emits **`connection-accepted`** — the client's
  `initSocketClient()` resolves on this event.
- On failure the handshake is rejected → the client sees `connect_error` /
  `disconnect` and shows "Could not connect to the voice server."
- The authenticated `userId` is the identity for ALL room actions. The
  server never trusts a client-supplied user id.

### Origin allowlist

`ALLOWED_ORIGINS` (comma-separated). Unknown browser origins are rejected
at the socket.io CORS layer — this is the failure class behind the old
`3000 "origin not allowed"`. Non-browser clients (no `Origin` header)
are allowed through; the Bearer token is the real gate.

## 2. Client → server events

| Event | Payload | Ack | Notes |
|---|---|---|---|
| `create-room` | `CreateBroadcastDto` `{name?, description?, accessMode, type, tokenAddress[], invitedUsers[], image}` | `{ id, rtpCapabilities }` | Caller becomes owner. See §4 for the `rtpCapabilities` shape. |
| `join-room` | `{ broadcastId, device }` | `{ rtpCapabilities }` | `ack(null)` + `error` event when the room is missing / invitation-only. |
| `media` | `{ broadcastId, msg: { event, data } }` | varies | Sub-events below. |
| `invite-members` | `{ users: string[] }` | — | Owner only; adds to the invitation list. |
| `toggle-messaging-permission` | `{ broadcastId, userId }` | — | Owner only; flips the per-user flag. |
| `kick-user` | `{ broadcastId, userId }` | — | Owner only. Target gets `user-kicked`. |
| `leave-room` | `{ broadcastId }` | — | Owner leaving finishes the broadcast. |
| `request-to-talk` | `{ request: boolean }` | — | Forwarded to the owner as `talk-request`. |

### `media` sub-events (`msg.event`)

| Event | `data` | Ack |
|---|---|---|
| `createWebRtcTransport` | `{ type: "producer" \| "consumer" }` | `{ params: { id, iceParameters, iceCandidates, dtlsParameters } }` |
| `connectWebRtcTransport` | `{ dtlsParameters, type }` | `ack()` (no args) |
| `produce` | `{ kind, rtpParameters, appData }` | `{ id }` (producer id). Requires talk permission; otherwise `ack(null)` + `error`. |
| `consume` | `{ rtpCapabilities, user_id, kind }` | `{ id, producerId, kind, rtpParameters }` |
| `get-producers` | `null` | `string[]` — producer ids of OTHER participants |
| `toggleMemberTalkPermission` | `{ user_id }` | `{ canTalk }`; target socket gets `toggle-talk-permission` |

> **Naming quirk:** `new-producer-joined`'s `user_id` and `consume`'s
> `user_id` are **producer ids**, not user ids — the client passes them
> straight into `consume({ user_id })`. The server treats them as such.

## 3. Server → client events

| Event | Payload | Meaning |
|---|---|---|
| `connection-accepted` | `{}` | Auth OK, socket ready. |
| `error` | `{ data: string }` | Human-readable failure. EVERY failure path emits this; nothing fails silently. |
| `new-producer-joined` | `{ user_id, kind }` | Someone started publishing (sent to everyone except the publisher). |
| `consumer-closed` | `{ user_id }` | A producer closed — drop the matching consumer. |
| `broadcast-finished` | `{}` | Owner left; the room is gone. |
| `user-disconnected` | `{ id }` | A participant left/disconnected (`id` = user id). |
| `user-kicked` | `{}` | You were removed by the owner. |
| `toggle-talk-permission` | `boolean` | Truthy = you may publish (client builds its producer transport); falsy = stop publishing. |
| `talk-request` | `{ userId, request }` | Forwarded to the room owner (no hook listener yet; kept for the host UI). |

## 4. `rtpCapabilities` ack shape (compat shim)

The two client hooks disagree:

- `use.ama.ts` (`create-room` and `join-room`): reads `data.rtpCapabilities`
  **flat** and passes it to `mediasoupClient.Device.load()`.
- `use.live.ts` (`create-room`): reads `data.rtpCapabilities.rtpCapabilities`
  **nested**.
- `use.live.ts` (`join-room`): reads `data.rtpCapabilities` flat.

The server acks `create-room` with

```json
{ "id": "<roomId>", "rtpCapabilities": { "...routerCaps", "rtpCapabilities": { "...routerCaps" } } }
```

so both shapes resolve to the real router capabilities
(`mediasoup-client` ignores the extra key). `join-room` acks
`{ "rtpCapabilities": { "...routerCaps" } }` flat, which both hooks read
correctly.

## 5. Room lifecycle & permissions

- One mediasoup **Router per room**, assigned round-robin across workers.
- The room creator is the **owner** (`isOwner`, `canTalk: true`).
- Joiners in `ama` rooms start with `canTalk: false` and must be granted
  via `toggleMemberTalkPermission`; in `live` rooms everyone can publish.
- `invitation` access-mode rooms only admit `invitedUsers` (owner bypasses).
- Owner-only actions are enforced **server-side** (`kick-user`,
  `toggleMemberTalkPermission`, `toggle-messaging-permission`,
  `invite-members`) — the client's `globalIsOwner` flag is UI only.
- Owner leaving → `broadcast-finished` to the room, router closed, room
  destroyed. Participant leaving/disconnect → their producers closed,
  `consumer-closed` per producer + `user-disconnected` broadcast.

## 6. Health

`GET /health` → `{ "status": "ok", "rooms": <n>, "uptime": <seconds> }`.
