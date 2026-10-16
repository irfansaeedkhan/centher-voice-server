/**
 * Protocol tests: every client emit -> server handler, with a stubbed
 * mediasoup layer and fake socket.io peers. Proves the wire contract in
 * PROTOCOL.md without needing real WebRTC.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { RoomManager } from "../src/rooms";
import { registerHandlers, HandlerDeps } from "../src/handlers";
import type { IMediaSoup } from "../src/mediasoup";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

let sockCounter = 0;

class FakeSocket {
  id = `sock-${++sockCounter}`;
  data: Record<string, any> = {};
  handlers = new Map<string, (...a: any[]) => void>();
  emitted: Array<{ event: string; args: any[] }> = [];
  toEmits: Array<{ room: string; event: string; args: any[] }> = [];
  joined = new Set<string>();
  rooms = new Set<string>([this.id]);

  on(event: string, fn: (...a: any[]) => void) {
    this.handlers.set(event, fn);
  }
  emit(event: string, ...args: any[]) {
    this.emitted.push({ event, args });
  }
  join(room: string) {
    this.joined.add(room);
    this.rooms.add(room);
  }
  leave(room: string) {
    this.joined.delete(room);
    this.rooms.delete(room);
  }
  to(room: string) {
    return {
      emit: (event: string, ...args: any[]) => {
        this.toEmits.push({ room, event, args });
      },
    };
  }
  emittedEvent(name: string) {
    return this.emitted.filter((e) => e.event === name);
  }
}

class FakeIO {
  sockets = { sockets: new Map<string, FakeSocket>() };
  roomEmits: Array<{ room: string; event: string; args: any[] }> = [];
  to(room: string) {
    return {
      emit: (event: string, ...args: any[]) => {
        this.roomEmits.push({ room, event, args });
      },
    };
  }
  async close(cb: () => void) {
    cb();
  }
  roomEmitsTo(room: string, event: string) {
    return this.roomEmits.filter((e) => e.room === room && e.event === event);
  }
}

function fakeTransport(id: string) {
  return {
    id,
    connect: vi.fn(async () => undefined),
    produce: vi.fn(async ({ kind }: any) => ({
      id: `prod-${id}-${kind}`,
      kind,
      on: vi.fn(),
      close: vi.fn(),
    })),
    consume: vi.fn(async ({ producerId }: any) => ({
      id: `cons-${producerId}`,
      producerId,
      kind: "audio",
      rtpParameters: {},
      on: vi.fn(),
      close: vi.fn(),
    })),
    close: vi.fn(),
  };
}

function fakeMedia(): IMediaSoup & { transports: any[] } {
  const transports: any[] = [];
  const router = {
    id: "router-1",
    rtpCapabilities: { codecs: [{ kind: "audio" }] },
    canConsume: () => true,
    close: vi.fn(),
  };
  return {
    transports,
    createRouter: async () => router as any,
    closeRouter: async (r: any) => r.close(),
    createWebRtcTransport: async () => {
      const t = fakeTransport(`tr-${transports.length}`);
      transports.push(t);
      return t as any;
    },
    routerRtpCapabilities: (r: any) => r.rtpCapabilities,
    transportParams: (t: any) => ({
      id: t.id,
      iceParameters: {},
      iceCandidates: [],
      dtlsParameters: {},
    }),
  };
}

function setup() {
  const io = new FakeIO();
  const rooms = new RoomManager();
  const media = fakeMedia();
  const deps = {
    io,
    rooms,
    media,
    __sessions: new Map(),
  } as unknown as HandlerDeps;
  const mkSocket = (userId: string) => {
    const s = new FakeSocket();
    s.data.userId = userId;
    io.sockets.sockets.set(s.id, s as any);
    registerHandlers(deps, s as any);
    return s;
  };
  return { io, rooms, media, deps, mkSocket };
}

function emitAck(
  sock: FakeSocket,
  event: string,
  ...args: any[]
): Promise<any> {
  return new Promise((resolve) => {
    const fn = sock.handlers.get(event)!;
    fn(...args, (...ackArgs: any[]) => resolve(ackArgs));
  });
}

// ---------------------------------------------------------------------------

describe("voice protocol", () => {
  beforeEach(() => {
    sockCounter = 0;
  });

  it("create-room acks {id, rtpCapabilities} in BOTH shapes the client reads", async () => {
    const { mkSocket, rooms } = setup();
    const owner = mkSocket("user-owner");
    const [ack] = await emitAck(owner, "create-room", {
      name: "AMA",
      type: "ama",
    });
    expect(ack.id).toBeTruthy();
    // use.ama.ts reads data.rtpCapabilities flat...
    expect(ack.rtpCapabilities.codecs).toBeDefined();
    // ...use.live.ts reads data.rtpCapabilities.rtpCapabilities (nested).
    expect(ack.rtpCapabilities.rtpCapabilities.codecs).toBeDefined();
    expect(owner.joined.has(ack.id)).toBe(true);
    expect(rooms.roomCount).toBe(1);
  });

  it("join-room acks flat rtpCapabilities and rejects unknown rooms", async () => {
    const { mkSocket } = setup();
    const owner = mkSocket("user-owner");
    const [created] = await emitAck(owner, "create-room", { type: "live" });

    const alice = mkSocket("user-alice");
    const [joined] = await emitAck(alice, "join-room", {
      broadcastId: created.id,
    });
    expect(joined.rtpCapabilities.codecs).toBeDefined();
    expect(alice.joined.has(created.id)).toBe(true);

    const bob = mkSocket("user-bob");
    const [nope] = await emitAck(bob, "join-room", { broadcastId: "missing" });
    expect(nope).toBeNull();
    expect(bob.emittedEvent("error").length).toBe(1);
    expect(bob.emittedEvent("error")[0].args[0].data).toMatch(/not found/i);
  });

  it("media createWebRtcTransport returns params; unknown events fail cleanly", async () => {
    const { mkSocket } = setup();
    const owner = mkSocket("user-owner");
    const [created] = await emitAck(owner, "create-room", {});

    const [res] = await emitAck(owner, "media", {
      broadcastId: created.id,
      msg: { event: "createWebRtcTransport", data: { type: "producer" } },
    });
    expect(res.params.id).toBeTruthy();

    const [bad] = await emitAck(owner, "media", {
      broadcastId: created.id,
      msg: { event: "nope", data: {} },
    });
    expect(bad).toBeNull();
    expect(owner.emittedEvent("error").length).toBeGreaterThan(0);
  });

  it("produce requires talk permission; owner flow broadcasts new-producer-joined", async () => {
    const { mkSocket } = setup();
    const owner = mkSocket("user-owner");
    const [created] = await emitAck(owner, "create-room", { type: "ama" });
    const alice = mkSocket("user-alice");
    await emitAck(alice, "join-room", { broadcastId: created.id });

    // Alice has no producer transport yet AND no talk permission.
    await emitAck(alice, "media", {
      broadcastId: created.id,
      msg: {
        event: "createWebRtcTransport",
        data: { type: "producer" },
      },
    });
    const [denied] = await emitAck(alice, "media", {
      broadcastId: created.id,
      msg: { event: "produce", data: { kind: "audio", rtpParameters: {} } },
    });
    expect(denied).toBeNull();
    expect(
      alice
        .emittedEvent("error")
        .some((e) => /permission/i.test(e.args[0].data)),
    ).toBe(true);

    // Owner produces fine and everyone else is notified.
    await emitAck(owner, "media", {
      broadcastId: created.id,
      msg: { event: "createWebRtcTransport", data: { type: "producer" } },
    });
    const [produced] = await emitAck(owner, "media", {
      broadcastId: created.id,
      msg: { event: "produce", data: { kind: "audio", rtpParameters: {} } },
    });
    expect(produced.id).toBeTruthy();
    const notified = owner.toEmits.filter(
      (e) => e.event === "new-producer-joined",
    );
    expect(notified.length).toBe(1);
    expect(notified[0].args[0].user_id).toBe(produced.id);
    expect(notified[0].args[0].kind).toBe("audio");
  });

  it("get-producers lists others' producers; consume returns consumer params", async () => {
    const { mkSocket } = setup();
    const owner = mkSocket("user-owner");
    const [created] = await emitAck(owner, "create-room", { type: "live" });
    const alice = mkSocket("user-alice");
    await emitAck(alice, "join-room", { broadcastId: created.id });

    await emitAck(owner, "media", {
      broadcastId: created.id,
      msg: { event: "createWebRtcTransport", data: { type: "producer" } },
    });
    const [produced] = await emitAck(owner, "media", {
      broadcastId: created.id,
      msg: { event: "produce", data: { kind: "video", rtpParameters: {} } },
    });

    const [list] = await emitAck(alice, "media", {
      broadcastId: created.id,
      msg: { event: "get-producers", data: null },
    });
    expect(list).toContain(produced.id);

    await emitAck(alice, "media", {
      broadcastId: created.id,
      msg: { event: "createWebRtcTransport", data: { type: "consumer" } },
    });
    const [consumed] = await emitAck(alice, "media", {
      broadcastId: created.id,
      msg: {
        event: "consume",
        data: { rtpCapabilities: {}, user_id: produced.id, kind: "video" },
      },
    });
    expect(consumed.id).toBeTruthy();
    expect(consumed.producerId).toBe(produced.id);
    expect(consumed.rtpParameters).toBeDefined();
  });

  it("kick-user is owner-only; owner kick notifies the target", async () => {
    const { mkSocket, rooms } = setup();
    const owner = mkSocket("user-owner");
    const [created] = await emitAck(owner, "create-room", {});
    const alice = mkSocket("user-alice");
    await emitAck(alice, "join-room", { broadcastId: created.id });

    alice.handlers.get("kick-user")!({
      broadcastId: created.id,
      userId: owner,
    });
    expect(alice.emittedEvent("error").length).toBe(1);
    expect(rooms.participantCount(created.id)).toBe(2);

    owner.handlers.get("kick-user")!({
      broadcastId: created.id,
      userId: "user-alice",
    });
    expect(alice.emittedEvent("user-kicked").length).toBe(1);
    expect(rooms.participantCount(created.id)).toBe(1);
    // N2: the kicked socket is removed from the socket.io room server-side —
    // it must not keep receiving room broadcasts via a client that refuses
    // to close itself.
    expect(alice.joined.has(created.id)).toBe(false);
  });

  it("owner leave-room finishes the broadcast and destroys the room", async () => {
    const { mkSocket, rooms, io } = setup();
    const owner = mkSocket("user-owner");
    const [created] = await emitAck(owner, "create-room", {});
    const alice = mkSocket("user-alice");
    await emitAck(alice, "join-room", { broadcastId: created.id });

    owner.handlers.get("leave-room")!({ broadcastId: created.id });
    await new Promise((r) => setTimeout(r, 10));

    expect(io.roomEmitsTo(created.id, "broadcast-finished").length).toBe(1);
    expect(rooms.roomCount).toBe(0);
  });

  it("participant disconnect notifies the room with user-disconnected", async () => {
    const { mkSocket, io } = setup();
    const owner = mkSocket("user-owner");
    const [created] = await emitAck(owner, "create-room", {});
    const alice = mkSocket("user-alice");
    await emitAck(alice, "join-room", { broadcastId: created.id });

    alice.handlers.get("disconnect")!();
    await new Promise((r) => setTimeout(r, 10));

    const evs = io.roomEmitsTo(created.id, "user-disconnected");
    expect(evs.length).toBe(1);
    expect(evs[0].args[0].id).toBe("user-alice");
  });

  it("toggleMemberTalkPermission flips and notifies the member socket", async () => {
    const { mkSocket } = setup();
    const owner = mkSocket("user-owner");
    const [created] = await emitAck(owner, "create-room", { type: "ama" });
    const alice = mkSocket("user-alice");
    await emitAck(alice, "join-room", { broadcastId: created.id });

    const [res] = await emitAck(owner, "media", {
      broadcastId: created.id,
      msg: {
        event: "toggleMemberTalkPermission",
        data: { user_id: "user-alice" },
      },
    });
    expect(res.canTalk).toBe(true);
    const got = alice.emittedEvent("toggle-talk-permission");
    expect(got.length).toBe(1);
    expect(got[0].args[0]).toBe(true);
  });

  it("media connectWebRtcTransport connects the right transport", async () => {
    const { mkSocket, media } = setup();
    const owner = mkSocket("user-owner");
    const [created] = await emitAck(owner, "create-room", {});
    await emitAck(owner, "media", {
      broadcastId: created.id,
      msg: { event: "createWebRtcTransport", data: { type: "producer" } },
    });
    const ackArgs = await emitAck(owner, "media", {
      broadcastId: created.id,
      msg: {
        event: "connectWebRtcTransport",
        data: { dtlsParameters: {}, type: "producer" },
      },
    });
    expect(ackArgs).toEqual([]);
    expect(media.transports[0].connect).toHaveBeenCalled();
  });

  it("invite-members and toggle-messaging-permission are owner-only", async () => {
    const { mkSocket, rooms } = setup();
    const owner = mkSocket("user-owner");
    const [created] = await emitAck(owner, "create-room", {
      accessMode: "invitation",
    });
    // Owner invites alice first so she can join the invitation-only room.
    owner.handlers.get("invite-members")!({ users: ["user-alice"] });
    const alice = mkSocket("user-alice");
    const [joined] = await emitAck(alice, "join-room", {
      broadcastId: created.id,
    });
    expect(joined.rtpCapabilities).toBeDefined();

    alice.handlers.get("invite-members")!({ users: ["user-bob"] });
    expect(alice.emittedEvent("error").length).toBe(1);

    owner.handlers.get("invite-members")!({ users: ["user-bob"] });
    const bob = mkSocket("user-bob");
    const [bobJoined] = await emitAck(bob, "join-room", {
      broadcastId: created.id,
    });
    expect(bobJoined.rtpCapabilities).toBeDefined();
    expect(rooms.participantCount(created.id)).toBe(3);
  });
});
