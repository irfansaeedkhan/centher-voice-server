/**
 * Socket.io protocol handlers — the exact wire contract the Centher web app
 * expects (see PROTOCOL.md).
 *
 * Pattern #7 ("the user is never stranded") is enforced here structurally:
 *  - every handler is wrapped in try/catch; failures emit a readable
 *    `error` event ({ data }) instead of dying silently;
 *  - every ack callback is ALWAYS invoked (with data or null) so the
 *    client never hangs on a loader;
 *  - no unhandled promise rejections.
 */
import type { Server, Socket } from "socket.io";
import type {
  Consumer,
  Producer,
  Router,
  WebRtcTransport,
} from "mediasoup/node/lib/types";
import { RoomManager } from "./rooms";
import type { IMediaSoup } from "./mediasoup";
import type { CreateRoomInput, MediaMessage } from "./types";

export interface HandlerDeps {
  io: Server;
  rooms: RoomManager;
  media: IMediaSoup;
}

interface PeerSession {
  userId: string;
  roomId: string | null;
  producerTransport: WebRtcTransport | null;
  consumerTransport: WebRtcTransport | null;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

function newSession(userId: string): PeerSession {
  return {
    userId,
    roomId: null,
    producerTransport: null,
    consumerTransport: null,
    producers: new Map(),
    consumers: new Map(),
  };
}

type Ack = (...args: any[]) => void;

export function registerHandlers(deps: HandlerDeps, socket: Socket): void {
  const { io, rooms, media } = deps;
  const userId = socket.data.userId as string;
  const sessions = (deps as any).__sessions as Map<string, PeerSession>;
  const session = newSession(userId);
  sessions.set(socket.id, session);

  const fail = (ack: Ack | undefined, message: string) => {
    socket.emit("error", { data: message });
    if (ack) ack(null);
  };

  const socketOf = (
    targetUserId: string,
    roomId: string,
  ): Socket | undefined => {
    const room = rooms.getRoom(roomId);
    const target = room?.participants.get(targetUserId);
    if (!target?.socketId) return undefined;
    return io.sockets.sockets.get(target.socketId);
  };

  // ------------------------------------------------------------------
  socket.on("create-room", async (input: CreateRoomInput, ack: Ack) => {
    try {
      const room = rooms.createRoom(userId, input || {});
      const router = (await media.createRouter()) as Router;
      room.router = router;
      rooms.setParticipantSocket(room.id, userId, socket.id);
      session.roomId = room.id;
      socket.join(room.id);

      const caps = media.routerRtpCapabilities(router) as Record<string, any>;
      // Compat shim: use.ama.ts reads data.rtpCapabilities flat while
      // use.live.ts reads data.rtpCapabilities.rtpCapabilities (nested).
      // Serve both shapes at once; mediasoup-client ignores extra keys.
      ack({ id: room.id, rtpCapabilities: { ...caps, rtpCapabilities: caps } });
    } catch (err) {
      fail(ack, `Could not create the room: ${(err as Error).message}`);
    }
  });

  // ------------------------------------------------------------------
  socket.on(
    "join-room",
    async (payload: { broadcastId: string; device?: string }, ack: Ack) => {
      try {
        const result = rooms.joinRoom(userId, payload?.broadcastId);
        if (!result.ok) {
          fail(ack, result.reason);
          return;
        }
        rooms.setParticipantSocket(result.room.id, userId, socket.id);
        session.roomId = result.room.id;
        socket.join(result.room.id);
        const caps = media.routerRtpCapabilities(result.room.router as Router);
        ack({ rtpCapabilities: caps });
      } catch (err) {
        fail(ack, `Could not join the room: ${(err as Error).message}`);
      }
    },
  );

  // ------------------------------------------------------------------
  socket.on("media", async (payload: MediaMessage, ack: Ack) => {
    try {
      const event = payload?.msg?.event;
      const data = payload?.msg?.data;
      const roomId = payload?.broadcastId || session.roomId;
      if (!roomId || !rooms.getRoom(roomId)) {
        fail(ack, "You are not in a room.");
        return;
      }
      switch (event) {
        case "createWebRtcTransport":
          await handleCreateTransport(data, roomId, session, rooms, media, ack);
          break;
        case "connectWebRtcTransport":
          await handleConnectTransport(data, session, ack);
          break;
        case "produce":
          await handleProduce(data, roomId, session, deps, ack, socket, userId);
          break;
        case "consume":
          await handleConsume(data, roomId, session, deps, ack, userId);
          break;
        case "get-producers":
          ack(rooms.visibleProducers(roomId, userId));
          break;
        case "toggleMemberTalkPermission":
          handleToggleTalk(data, roomId, deps, socket, userId, ack);
          break;
        default:
          fail(ack, `Unknown media event: ${event}`);
      }
    } catch (err) {
      fail(ack, `Media request failed: ${(err as Error).message}`);
    }
  });

  // ------------------------------------------------------------------
  socket.on("invite-members", (payload: { users?: string[] }) => {
    try {
      const roomId = session.roomId;
      if (!roomId) return;
      const result = rooms.inviteMembers(userId, roomId, payload?.users || []);
      if (!result.ok) socket.emit("error", { data: result.reason });
    } catch (err) {
      socket.emit("error", { data: (err as Error).message });
    }
  });

  socket.on(
    "toggle-messaging-permission",
    (payload: { broadcastId?: string; userId?: string }) => {
      try {
        const roomId = payload?.broadcastId || session.roomId;
        if (!roomId || !payload?.userId) return;
        const result = rooms.toggleMessagingPermission(
          userId,
          roomId,
          payload.userId,
        );
        if (!result.ok) socket.emit("error", { data: result.reason });
      } catch (err) {
        socket.emit("error", { data: (err as Error).message });
      }
    },
  );

  socket.on(
    "kick-user",
    (payload: { broadcastId?: string; userId?: string }) => {
      try {
        const roomId = payload?.broadcastId || session.roomId;
        if (!roomId || !payload?.userId) return;
        // Capture the target socket BEFORE kickUser removes the participant.
        const targetSocket = socketOf(payload.userId, roomId);
        const result = rooms.kickUser(userId, roomId, payload.userId);
        if (!result.ok) {
          socket.emit("error", { data: result.reason });
          return;
        }
        closePeerMedia(deps, targetSocket?.id, roomId, payload.userId).catch(
          () => undefined,
        );
        targetSocket?.emit("user-kicked", {});
        for (const pid of result.producerIds) {
          io.to(roomId).emit("consumer-closed", { user_id: pid });
        }
        io.to(roomId).emit("user-disconnected", { id: payload.userId });
      } catch (err) {
        socket.emit("error", { data: (err as Error).message });
      }
    },
  );

  socket.on("leave-room", (payload: { broadcastId?: string }) => {
    const roomId = payload?.broadcastId || session.roomId;
    if (roomId) void leaveRoom(deps, socket, session, roomId, userId);
  });

  socket.on("request-to-talk", (payload: { request?: boolean }) => {
    try {
      const roomId = session.roomId;
      if (!roomId) return;
      const room = rooms.getRoom(roomId);
      if (!room) return;
      const ownerSocket = socketOf(room.ownerId, roomId);
      ownerSocket?.emit("talk-request", {
        userId,
        request: !!payload?.request,
      });
    } catch (err) {
      socket.emit("error", { data: (err as Error).message });
    }
  });

  socket.on("disconnect", () => {
    const roomId = session.roomId;
    sessions.delete(socket.id);
    if (roomId) void leaveRoom(deps, socket, session, roomId, userId);
  });
}

// ---------------------------------------------------------------------------
// Media sub-handlers
// ---------------------------------------------------------------------------

async function handleCreateTransport(
  data: { type?: string },
  roomId: string,
  session: PeerSession,
  rooms: RoomManager,
  media: IMediaSoup,
  ack: Ack,
): Promise<void> {
  const room = rooms.getRoom(roomId);
  if (!room?.router) throw new Error("Room media is not ready.");
  const transport = await media.createWebRtcTransport(room.router as Router);
  if (data?.type === "consumer") session.consumerTransport = transport;
  else session.producerTransport = transport;
  ack({ params: media.transportParams(transport) });
}

async function handleConnectTransport(
  data: { dtlsParameters?: any; type?: string },
  session: PeerSession,
  ack: Ack,
): Promise<void> {
  const transport =
    data?.type === "consumer"
      ? session.consumerTransport
      : session.producerTransport;
  if (!transport) throw new Error("Transport not found — create it first.");
  await transport.connect({ dtlsParameters: data.dtlsParameters });
  ack();
}

async function handleProduce(
  data: { kind?: string; rtpParameters?: any; appData?: any },
  roomId: string,
  session: PeerSession,
  deps: HandlerDeps,
  ack: Ack,
  socket: Socket,
  userId: string,
): Promise<void> {
  const { rooms } = deps;
  if (!session.producerTransport)
    throw new Error("Producer transport not found — create it first.");
  if (!rooms.canPublish(roomId, userId)) {
    socket.emit("error", {
      data: "You don't have permission to talk in this room yet.",
    });
    ack(null);
    return;
  }
  const producer = await session.producerTransport.produce({
    kind: (data?.kind === "video" ? "video" : "audio") as "audio" | "video",
    rtpParameters: data.rtpParameters,
    appData: data?.appData || {},
  });
  session.producers.set(producer.id, producer);
  rooms.addProducer(roomId, userId, producer.id, producer.kind);
  producer.on("transportclose", () => {
    session.producers.delete(producer.id);
    rooms.removeProducer(roomId, userId, producer.id);
  });
  socket
    .to(roomId)
    .emit("new-producer-joined", { user_id: producer.id, kind: producer.kind });
  ack({ id: producer.id });
}

async function handleConsume(
  data: { rtpCapabilities?: any; user_id?: string; kind?: string },
  roomId: string,
  session: PeerSession,
  deps: HandlerDeps,
  ack: Ack,
  userId: string,
): Promise<void> {
  const { rooms } = deps;
  const room = rooms.getRoom(roomId);
  const router = room?.router as Router | undefined;
  if (!router) throw new Error("Room media is not ready.");
  if (!session.consumerTransport)
    throw new Error("Consumer transport not found — create it first.");
  if (!data?.user_id) throw new Error("Missing stream id.");
  const owner = rooms.findProducerOwner(roomId, data.user_id);
  if (!owner) throw new Error("That stream is no longer available.");
  if (
    !router.canConsume({
      producerId: data.user_id,
      rtpCapabilities: data.rtpCapabilities,
    })
  ) {
    throw new Error("Cannot consume this stream with your device.");
  }
  const consumer = await session.consumerTransport.consume({
    producerId: data.user_id,
    rtpCapabilities: data.rtpCapabilities,
    paused: false,
  });
  session.consumers.set(consumer.id, consumer);
  consumer.on("transportclose", () => session.consumers.delete(consumer.id));
  consumer.on("producerclose", () => {
    session.consumers.delete(consumer.id);
    // Tell this client to drop the matching consumer UI.
    // (Broadcast form is handled by producer-owner disconnect/kick.)
  });
  ack({
    id: consumer.id,
    producerId: data.user_id,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  });
}

function handleToggleTalk(
  data: { user_id?: string },
  roomId: string,
  deps: HandlerDeps,
  socket: Socket,
  userId: string,
  ack: Ack,
): void {
  const { io, rooms } = deps;
  if (!data?.user_id) {
    socket.emit("error", { data: "Missing member id." });
    ack(null);
    return;
  }
  const result = rooms.toggleTalkPermission(userId, roomId, data.user_id);
  if (!result.ok) {
    socket.emit("error", { data: result.reason });
    ack(null);
    return;
  }
  const room = rooms.getRoom(roomId);
  const target = room?.participants.get(data.user_id);
  const targetSocket = target?.socketId
    ? io.sockets.sockets.get(target.socketId)
    : undefined;
  // Client treats truthy as "granted" (creates producer transport),
  // falsy as "revoked" (closes its producer).
  targetSocket?.emit("toggle-talk-permission", result.canTalk);
  ack({ canTalk: result.canTalk });
}

// ---------------------------------------------------------------------------
// Leave / cleanup
// ---------------------------------------------------------------------------

async function closePeerMedia(
  deps: HandlerDeps,
  socketId: string | undefined,
  roomId: string,
  userId: string,
): Promise<void> {
  const sessions = (deps as any).__sessions as Map<string, PeerSession>;
  const session = socketId ? sessions.get(socketId) : undefined;
  if (!session) return;
  for (const producer of session.producers.values()) {
    try {
      producer.close();
    } catch {
      /* already closed */
    }
    deps.rooms.removeProducer(roomId, userId, producer.id);
  }
  session.producers.clear();
  for (const consumer of session.consumers.values()) {
    try {
      consumer.close();
    } catch {
      /* already closed */
    }
  }
  session.consumers.clear();
  for (const t of [session.producerTransport, session.consumerTransport]) {
    try {
      t?.close();
    } catch {
      /* already closed */
    }
  }
  session.producerTransport = null;
  session.consumerTransport = null;
  session.roomId = null;
}

export async function leaveRoom(
  deps: HandlerDeps,
  socket: Socket,
  session: PeerSession,
  roomId: string,
  userId: string,
): Promise<void> {
  const { io, rooms, media } = deps;
  try {
    const outcome = rooms.leaveRoom(userId, roomId);
    await closePeerMedia(deps, socket.id, roomId, userId);
    if (!outcome) return;
    if (outcome.finished) {
      io.to(roomId).emit("broadcast-finished", {});
      try {
        await media.closeRouter(outcome.room.router as Router);
      } catch {
        /* already closed */
      }
      for (const s of io.sockets.sockets.values()) {
        if (s.rooms.has(roomId)) s.leave(roomId);
      }
    } else {
      for (const pid of outcome.producerIds) {
        io.to(roomId).emit("consumer-closed", { user_id: pid });
      }
      io.to(roomId).emit("user-disconnected", { id: userId });
    }
  } catch (err) {
    console.error(`[leave] cleanup failed: ${(err as Error).message}`);
  }
}
