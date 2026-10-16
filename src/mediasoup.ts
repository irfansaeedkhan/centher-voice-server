/**
 * mediasoup SFU management: workers, per-room routers, WebRTC transports.
 *
 * Scaling choice: one Router per room, assigned round-robin across workers
 * (classic mediasoup pattern). Rooms are fully isolated from each other;
 * a room's media never crosses routers. Workers are capped (see config)
 * so the Always Free VM isn't starved.
 */
import * as mediasoup from "mediasoup";
import type {
  Router,
  WebRtcTransport,
  Worker,
  RtpCodecCapability,
} from "mediasoup/node/lib/types";
import { config } from "./config";

export const mediaCodecs: RtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 111,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    preferredPayloadType: 96,
    parameters: { "x-google-start-bitrate": "1000" },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    preferredPayloadType: 125,
    parameters: {
      "packetization-mode": "1",
      "profile-level-id": "4d0032",
      "level-asymmetry-allowed": "1",
    },
  },
];

export interface TransportParams {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown;
  dtlsParameters: unknown;
}

/** Minimal surface the socket handlers need — mockable in tests. */
export interface IMediaSoup {
  createRouter(): Promise<Router>;
  closeRouter(router: Router): Promise<void>;
  createWebRtcTransport(router: Router): Promise<WebRtcTransport>;
  routerRtpCapabilities(router: Router): unknown;
  transportParams(t: WebRtcTransport): TransportParams;
}

export class MediasoupManager implements IMediaSoup {
  private workers: Worker[] = [];
  private nextWorker = 0;

  async init(): Promise<void> {
    for (let i = 0; i < config.mediasoup.numWorkers; i++) {
      const worker = await mediasoup.createWorker();
      worker.on("died", () => {
        console.error(
          `[mediasoup] worker died (pid ${worker.pid}) — exiting so the container restarts clean`,
        );
        process.exit(1);
      });
      this.workers.push(worker);
    }
    console.log(`[mediasoup] ${this.workers.length} workers ready`);
  }

  private pickWorker(): Worker {
    const worker = this.workers[this.nextWorker];
    this.nextWorker = (this.nextWorker + 1) % this.workers.length;
    return worker;
  }

  async createRouter(): Promise<Router> {
    const worker = this.pickWorker();
    return worker.createRouter({ mediaCodecs });
  }

  async closeRouter(router: Router): Promise<void> {
    try {
      router.close();
    } catch (err) {
      console.error("[mediasoup] router close failed:", (err as Error).message);
    }
  }

  async createWebRtcTransport(router: Router): Promise<WebRtcTransport> {
    return router.createWebRtcTransport({
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: config.mediasoup.announcedIp,
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
    });
  }

  routerRtpCapabilities(router: Router): unknown {
    return router.rtpCapabilities;
  }

  transportParams(t: WebRtcTransport): TransportParams {
    return MediasoupManager.transportParams(t);
  }

  static transportParams(t: WebRtcTransport): TransportParams {
    return {
      id: t.id,
      iceParameters: t.iceParameters,
      iceCandidates: t.iceCandidates,
      dtlsParameters: t.dtlsParameters,
    };
  }
}
