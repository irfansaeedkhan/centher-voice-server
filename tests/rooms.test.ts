import { describe, it, expect, beforeEach } from "vitest";
import { RoomManager } from "../src/rooms";

describe("RoomManager", () => {
  let mgr: RoomManager;
  const owner = "user-owner";
  const alice = "user-alice";
  const bob = "user-bob";

  beforeEach(() => {
    mgr = new RoomManager();
  });

  it("creates a room with the caller as owner", () => {
    const room = mgr.createRoom(owner, { name: "AMA night", type: "ama" });
    expect(room.id).toBeTruthy();
    expect(room.ownerId).toBe(owner);
    expect(room.name).toBe("AMA night");
    const p = room.participants.get(owner)!;
    expect(p.isOwner).toBe(true);
    expect(p.canTalk).toBe(true);
    expect(mgr.roomCount).toBe(1);
  });

  it("lets anyone join a public room", () => {
    const room = mgr.createRoom(owner, { accessMode: "public" });
    const res = mgr.joinRoom(alice, room.id);
    expect(res.ok).toBe(true);
    expect(mgr.participantCount(room.id)).toBe(2);
  });

  it("rejects joining a missing room with a readable reason", () => {
    const res = mgr.joinRoom(alice, "nope");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/not found/i);
  });

  it("enforces invitation-only rooms", () => {
    const room = mgr.createRoom(owner, {
      accessMode: "invitation",
      invitedUsers: [alice],
    });
    const denied = mgr.joinRoom(bob, room.id);
    expect(denied.ok).toBe(false);

    const allowed = mgr.joinRoom(alice, room.id);
    expect(allowed.ok).toBe(true);
  });

  it("owner leaving finishes the broadcast and destroys the room", () => {
    const room = mgr.createRoom(owner, {});
    mgr.joinRoom(alice, room.id);
    const out = mgr.leaveRoom(owner, room.id);
    expect(out?.finished).toBe(true);
    expect(mgr.getRoom(room.id)).toBeUndefined();
    expect(mgr.roomCount).toBe(0);
  });

  it("participant leaving keeps the room and reports their producers", () => {
    const room = mgr.createRoom(owner, {});
    mgr.joinRoom(alice, room.id);
    mgr.addProducer(room.id, alice, "prod-1", "audio");
    const out = mgr.leaveRoom(alice, room.id);
    expect(out?.finished).toBe(false);
    if (out && !out.finished) expect(out.producerIds).toEqual(["prod-1"]);
    expect(mgr.getRoom(room.id)).toBeDefined();
    expect(mgr.participantCount(room.id)).toBe(1);
  });

  it("only the owner can kick, and the owner cannot kick themselves", () => {
    const room = mgr.createRoom(owner, {});
    mgr.joinRoom(alice, room.id);

    const notOwner = mgr.kickUser(alice, room.id, owner);
    expect(notOwner.ok).toBe(false);

    const selfKick = mgr.kickUser(owner, room.id, owner);
    expect(selfKick.ok).toBe(false);

    const ok = mgr.kickUser(owner, room.id, alice);
    expect(ok.ok).toBe(true);
    expect(mgr.participantCount(room.id)).toBe(1);
  });

  it("kicking a non-member fails cleanly", () => {
    const room = mgr.createRoom(owner, {});
    const res = mgr.kickUser(owner, room.id, "ghost");
    expect(res.ok).toBe(false);
  });

  it("toggles talk permission owner-only and flips the flag", () => {
    const room = mgr.createRoom(owner, { type: "ama" });
    mgr.joinRoom(alice, room.id);

    const denied = mgr.toggleTalkPermission(alice, room.id, alice);
    expect(denied.ok).toBe(false);

    const grant = mgr.toggleTalkPermission(owner, room.id, alice);
    expect(grant.ok).toBe(true);
    if (grant.ok) expect(grant.canTalk).toBe(true);
    expect(mgr.canPublish(room.id, alice)).toBe(true);

    const revoke = mgr.toggleTalkPermission(owner, room.id, alice);
    if (revoke.ok) expect(revoke.canTalk).toBe(false);
    expect(mgr.canPublish(room.id, alice)).toBe(false);
  });

  it("owner can always publish; strangers cannot", () => {
    const room = mgr.createRoom(owner, { type: "ama" });
    expect(mgr.canPublish(room.id, owner)).toBe(true);
    expect(mgr.canPublish(room.id, "stranger")).toBe(false);
  });

  it("inviteMembers is owner-only and unlocks invitation rooms", () => {
    const room = mgr.createRoom(owner, { accessMode: "invitation" });
    const denied = mgr.inviteMembers(alice, room.id, [bob]);
    expect(denied.ok).toBe(false);

    const ok = mgr.inviteMembers(owner, room.id, [bob]);
    expect(ok.ok).toBe(true);
    expect(mgr.joinRoom(bob, room.id).ok).toBe(true);
  });

  it("toggleMessagingPermission flips per-user and is owner-only", () => {
    const room = mgr.createRoom(owner, {});
    mgr.joinRoom(alice, room.id);
    const denied = mgr.toggleMessagingPermission(alice, room.id, alice);
    expect(denied.ok).toBe(false);
    const r1 = mgr.toggleMessagingPermission(owner, room.id, alice);
    expect(r1.ok && r1.allowed).toBe(false);
    const r2 = mgr.toggleMessagingPermission(owner, room.id, alice);
    expect(r2.ok && r2.allowed).toBe(true);
  });

  it("visibleProducers excludes the requester's own producers", () => {
    const room = mgr.createRoom(owner, {});
    mgr.joinRoom(alice, room.id);
    mgr.addProducer(room.id, owner, "p-owner", "audio");
    mgr.addProducer(room.id, alice, "p-alice", "audio");
    expect(mgr.visibleProducers(room.id, alice)).toEqual(["p-owner"]);
    expect(mgr.visibleProducers(room.id, owner)).toEqual(["p-alice"]);
  });

  it("findProducerOwner locates who owns a producer", () => {
    const room = mgr.createRoom(owner, {});
    mgr.joinRoom(alice, room.id);
    mgr.addProducer(room.id, alice, "p-alice", "video");
    expect(mgr.findProducerOwner(room.id, "p-alice")?.userId).toBe(alice);
    expect(mgr.findProducerOwner(room.id, "nope")).toBeUndefined();
  });

  it("findRoomBySocket locates the room for a socket", () => {
    const room = mgr.createRoom(owner, {});
    mgr.setParticipantSocket(room.id, owner, "sock-1");
    expect(mgr.findRoomBySocket("sock-1")?.id).toBe(room.id);
    expect(mgr.findRoomBySocket("sock-9")).toBeUndefined();
  });

  it("leaving a missing room returns null (no crash)", () => {
    expect(mgr.leaveRoom(alice, "nope")).toBeNull();
  });
});
