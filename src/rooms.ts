/**
 * Room state machine. Pure domain logic — no sockets, no mediasoup calls.
 * Handlers translate the returned outcomes into wire events.
 *
 * Security rule: the OWNER is always the authenticated userId from the
 * Bearer token, never a client-supplied id. Privileged actions (kick,
 * talk-permission, messaging-permission, invite) are owner-only here, so
 * future callers inherit the checks.
 */
import { v4 as uuidv4 } from "uuid";
import type { CreateRoomInput, Participant, Room } from "./types";

export class RoomManager {
  private rooms = new Map<string, Room>();

  get roomCount(): number {
    return this.rooms.size;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  findRoomBySocket(socketId: string): Room | undefined {
    for (const room of this.rooms.values()) {
      for (const p of room.participants.values()) {
        if (p.socketId === socketId) return room;
      }
    }
    return undefined;
  }

  createRoom(ownerId: string, input: CreateRoomInput): Room {
    const room: Room = {
      id: uuidv4(),
      name: input.name || "Voice room",
      description: input.description || "",
      accessMode: input.accessMode || "public",
      type: input.type || "ama",
      image: input.image || "",
      ownerId,
      invitedUsers: new Set(input.invitedUsers || []),
      messagingPermission: new Map(),
      participants: new Map(),
      router: null, // attached by the caller (mediasoup)
    };
    room.participants.set(ownerId, {
      userId: ownerId,
      socketId: "",
      isOwner: true,
      canTalk: true,
      producers: new Map(),
    });
    this.rooms.set(room.id, room);
    return room;
  }

  setParticipantSocket(roomId: string, userId: string, socketId: string): void {
    const room = this.rooms.get(roomId);
    const p = room?.participants.get(userId);
    if (p) p.socketId = socketId;
  }

  /**
   * Returns { ok } or { ok:false, reason } — reason is a human-readable
   * message safe to surface to the client.
   */
  joinRoom(
    userId: string,
    roomId: string,
  ): { ok: true; room: Room } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "Room not found." };
    if (room.participants.has(userId)) {
      return { ok: true, room };
    }
    if (
      room.accessMode === "invitation" &&
      !room.invitedUsers.has(userId) &&
      room.ownerId !== userId
    ) {
      return { ok: false, reason: "This room is invitation-only." };
    }
    room.participants.set(userId, {
      userId,
      socketId: "",
      isOwner: false,
      // AMA-style rooms: participants request to talk; owner grants it.
      // Public/live rooms let everyone publish immediately.
      canTalk: room.type === "ama" ? false : true,
      producers: new Map(),
    });
    return { ok: true, room };
  }

  /**
   * Removes a participant. Returns what the caller must do:
   * - finished: owner left → room destroyed, broadcast `broadcast-finished`
   * - producerIds: producers to close/notify about
   */
  leaveRoom(
    userId: string,
    roomId: string,
  ):
    | { finished: true; room: Room }
    | { finished: false; room: Room; producerIds: string[] }
    | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const p = room.participants.get(userId);
    const producerIds = p ? [...p.producers.keys()] : [];
    if (room.ownerId === userId) {
      this.rooms.delete(roomId);
      return { finished: true, room };
    }
    if (p) room.participants.delete(userId);
    return { finished: false, room, producerIds };
  }

  kickUser(
    ownerId: string,
    roomId: string,
    targetUserId: string,
  ):
    | { ok: true; room: Room; producerIds: string[] }
    | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "Room not found." };
    if (room.ownerId !== ownerId)
      return { ok: false, reason: "Only the room owner can remove members." };
    if (targetUserId === ownerId)
      return { ok: false, reason: "The owner cannot remove themselves." };
    const target = room.participants.get(targetUserId);
    if (!target) return { ok: false, reason: "Member is not in this room." };
    const producerIds = [...target.producers.keys()];
    room.participants.delete(targetUserId);
    return { ok: true, room, producerIds };
  }

  toggleTalkPermission(
    ownerId: string,
    roomId: string,
    targetUserId: string,
  ): { ok: true; canTalk: boolean } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "Room not found." };
    if (room.ownerId !== ownerId)
      return {
        ok: false,
        reason: "Only the room owner can manage talk permission.",
      };
    const target = room.participants.get(targetUserId);
    if (!target) return { ok: false, reason: "Member is not in this room." };
    target.canTalk = !target.canTalk;
    return { ok: true, canTalk: target.canTalk };
  }

  toggleMessagingPermission(
    ownerId: string,
    roomId: string,
    targetUserId: string,
  ): { ok: true; allowed: boolean } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "Room not found." };
    if (room.ownerId !== ownerId)
      return {
        ok: false,
        reason: "Only the room owner can manage messaging permission.",
      };
    const current = room.messagingPermission.get(targetUserId) ?? true;
    room.messagingPermission.set(targetUserId, !current);
    return { ok: true, allowed: !current };
  }

  inviteMembers(
    ownerId: string,
    roomId: string,
    userIds: string[],
  ): { ok: true } | { ok: false; reason: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "Room not found." };
    if (room.ownerId !== ownerId)
      return { ok: false, reason: "Only the room owner can invite members." };
    for (const id of userIds) room.invitedUsers.add(id);
    return { ok: true };
  }

  addProducer(
    roomId: string,
    userId: string,
    producerId: string,
    kind: string,
  ): boolean {
    const p = this.rooms.get(roomId)?.participants.get(userId);
    if (!p) return false;
    p.producers.set(producerId, kind);
    return true;
  }

  removeProducer(roomId: string, userId: string, producerId: string): boolean {
    const p = this.rooms.get(roomId)?.participants.get(userId);
    if (!p) return false;
    return p.producers.delete(producerId);
  }

  /** Producer ids visible to `userId` (everyone's except their own). */
  visibleProducers(roomId: string, userId: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const ids: string[] = [];
    for (const p of room.participants.values()) {
      if (p.userId === userId) continue;
      for (const pid of p.producers.keys()) ids.push(pid);
    }
    return ids;
  }

  findProducerOwner(
    roomId: string,
    producerId: string,
  ): Participant | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    for (const p of room.participants.values()) {
      if (p.producers.has(producerId)) return p;
    }
    return undefined;
  }

  canPublish(roomId: string, userId: string): boolean {
    const p = this.rooms.get(roomId)?.participants.get(userId);
    return !!p && (p.isOwner || p.canTalk);
  }

  participantCount(roomId: string): number {
    return this.rooms.get(roomId)?.participants.size ?? 0;
  }
}
