/**
 * Shared protocol + domain types for the Centher voice server.
 *
 * The wire contract mirrors what the web app's VoiSpace hooks expect:
 *   hooks/stream/use.ama.ts, hooks/stream/use.live.ts,
 *   stream/clients/socket-client.ts (centher.dashboard.fullstack).
 */

// ---------------------------------------------------------------------------
// Room domain
// ---------------------------------------------------------------------------

export type RoomType = "ama" | "live";

export interface CreateRoomInput {
  name?: string;
  description?: string;
  accessMode?: string;
  type?: string;
  tokenAddress?: string[];
  invitedUsers?: string[];
  image?: string;
}

export interface Participant {
  userId: string;
  socketId: string;
  isOwner: boolean;
  /** Owner-granted permission to publish audio/video. */
  canTalk: boolean;
  /** producerId -> kind ("audio" | "video") */
  producers: Map<string, string>;
}

export interface Room {
  id: string;
  name: string;
  description: string;
  accessMode: string;
  type: string;
  image: string;
  ownerId: string;
  invitedUsers: Set<string>;
  /** userId -> messaging allowed (default true) */
  messagingPermission: Map<string, boolean>;
  participants: Map<string, Participant>;
  /** Opaque handle to the mediasoup Router; managed by mediasoup.ts. */
  router: unknown;
}

// ---------------------------------------------------------------------------
// Socket.io wire events (client -> server)
// ---------------------------------------------------------------------------

export interface MediaMessage {
  broadcastId: string;
  msg: {
    event: string;
    data: any;
  };
}

// ---------------------------------------------------------------------------
// Socket.io wire events (server -> client)
// ---------------------------------------------------------------------------

export interface NewProducerJoinedPayload {
  /** NOTE: despite the name, this is the PRODUCER id, not the user id —
   *  the client passes it straight into `consume({ user_id })`. */
  user_id: string;
  kind: string;
}

export interface UserDisconnectedPayload {
  id: string;
}

export interface ConsumerClosedPayload {
  /** Producer id whose consumer(s) should close. */
  user_id: string;
}
