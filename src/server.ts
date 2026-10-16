/**
 * HTTP + socket.io server wiring: CORS/origin allowlist, Bearer auth,
 * /health endpoint, handler registration.
 */
import http from "http";
import { Server, Socket } from "socket.io";
import { config } from "./config";
import { verifyBearerToken } from "./auth";
import { RoomManager } from "./rooms";
import type { IMediaSoup } from "./mediasoup";
import { HandlerDeps, registerHandlers } from "./handlers";

export interface VoiceServer {
  httpServer: http.Server;
  io: Server;
  rooms: RoomManager;
  close(): Promise<void>;
}

export async function createVoiceServer(
  media: IMediaSoup,
): Promise<VoiceServer> {
  const rooms = new RoomManager();

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          rooms: rooms.roomCount,
          uptime: Math.round(process.uptime()),
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        // Non-browser clients (curl, health checks) send no Origin.
        if (!origin) return callback(null, true);
        if (config.allowedOrigins.includes(origin)) return callback(null, true);
        console.warn(`[cors] rejected origin: ${origin}`);
        return callback(new Error(`Origin not allowed: ${origin}`));
      },
      credentials: true,
    },
  });

  const sessions = new Map<string, any>();
  const deps: HandlerDeps = { io, rooms, media };
  (deps as any).__sessions = sessions;

  io.use(async (socket: Socket, next) => {
    try {
      const raw = socket.handshake.headers["authorization"];
      const header = Array.isArray(raw) ? raw[0] : raw;
      const session = await verifyBearerToken(header);
      if (!session) {
        return next(new Error("unauthorized: invalid or expired session"));
      }
      socket.data.userId = session.userId;
      next();
    } catch (err) {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket: Socket) => {
    // The client resolves its loader on this event.
    socket.emit("connection-accepted", {});
    registerHandlers(deps, socket);
  });

  return {
    httpServer,
    io,
    rooms,
    async close() {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
