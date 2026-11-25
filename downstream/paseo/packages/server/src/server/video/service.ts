import path from "node:path";
import { ContentAddressedStore } from "./cas.js";
import { EditorAccessStore } from "./access.js";
import { MediaService } from "./media.js";
import { EditorJobSupervisor } from "./jobs.js";
import { EditorStore } from "./store.js";
import { EditorRpcService } from "./rpc.js";
import { AgentRunController } from "./agent/controller.js";
import type { EditorPrincipal } from "#video-editor/contracts/v1";

export interface EditorServiceOptions {
  paseoHome: string;
  ffmpeg?: string;
  ffprobe?: string;
}

export class EditorService {
  static async create(options: EditorServiceOptions): Promise<EditorService> {
    const store = await EditorStore.create(path.join(options.paseoHome, "video-editor"));
    return new EditorService({ ...options, store });
  }

  readonly store: EditorStore;
  readonly cas: ContentAddressedStore;
  readonly access: EditorAccessStore;
  readonly media: MediaService;
  readonly jobs: EditorJobSupervisor;
  readonly rpc: EditorRpcService;
  readonly agents: AgentRunController;

  constructor(options: EditorServiceOptions & { store: EditorStore }) {
    const root = path.join(options.paseoHome, "video-editor");
    this.store = options.store;
    this.cas = new ContentAddressedStore(path.join(root, "cas"));
    this.store.bindCas(this.cas);
    this.access = new EditorAccessStore(root);
    this.media = new MediaService(this.store, this.cas, {
      ffmpeg: options.ffmpeg ?? "ffmpeg",
      ffprobe: options.ffprobe ?? "ffprobe",
    });
    this.jobs = new EditorJobSupervisor(this.store, this.media);
    this.rpc = new EditorRpcService(this);
    this.agents = new AgentRunController(this.store);
  }

  async start(): Promise<void> {
    await this.cas.initialize();
    await this.access.initialize();
    this.agents.reconcile(this.store.projectsWithPlanningEvents(), this.principalForOwner());
    this.jobs.start();
  }

  async stop(): Promise<void> {
    await this.agents.disposeAll();
    await this.jobs.stop();
    this.store.close();
  }

  principalForOwner(): EditorPrincipal {
    return { principalId: "owner", role: "owner", projectIds: null };
  }
}
