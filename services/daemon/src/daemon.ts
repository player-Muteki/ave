import { randomBytes } from "node:crypto";
import path from "node:path";
import { ContentAddressedStore } from "@ave/cas";
import type { EditorPrincipal } from "@ave/contracts";
import { AveStore, resolveAveHome } from "@ave/sqlite";
import { DeterministicBackendRegistry } from "./backends/deterministic-backend.js";
import { FfmpegBackend } from "./backends/ffmpeg-backend.js";
import { AveJobSupervisor } from "./job-supervisor.js";
import { AvePlannerController, type PlannerDefaults } from "./planner-controller.js";
import { AveRpcRegistry } from "./rpc-registry.js";
import { DaemonQueries } from "./store-queries.js";
import { UploadManager } from "./upload-manager.js";
import { AveWsServer } from "./ws-server.js";

export interface AveDaemonOptions {
  aveHome?: string;
  host?: string;
  port?: number;
  ownerToken?: string;
  ffmpeg?: string;
  ffprobe?: string;
  planner?: PlannerDefaults;
  plannerWorkerEntryPath?: string;
}

export interface AveDaemonAddress {
  aveHome: string;
  host: string;
  port: number;
  wsUrl: string;
  healthUrl: string;
  ownerToken: string;
}

export class AveDaemon {
  readonly aveHome: string;
  readonly ownerToken: string;
  readonly store: AveStore;
  readonly cas: ContentAddressedStore;
  readonly backends: DeterministicBackendRegistry;
  readonly jobs: AveJobSupervisor;
  readonly uploads: UploadManager;
  readonly queries: DaemonQueries;
  readonly planner: AvePlannerController;
  readonly rpc: AveRpcRegistry;
  readonly ws: AveWsServer;
  private addressInfo?: AveDaemonAddress;

  static async create(options: AveDaemonOptions = {}): Promise<AveDaemon> {
    const aveHome = resolveAveHome(options.aveHome);
    const store = await AveStore.create(aveHome);
    const cas = new ContentAddressedStore(path.join(aveHome, "cas"));
    await cas.initialize();
    store.bindCas(cas);
    return new AveDaemon(aveHome, store, cas, options);
  }

  private constructor(
    aveHome: string,
    store: AveStore,
    cas: ContentAddressedStore,
    options: AveDaemonOptions,
  ) {
    this.aveHome = aveHome;
    this.ownerToken = options.ownerToken ?? randomBytes(24).toString("base64url");
    this.store = store;
    this.cas = cas;
    this.backends = new DeterministicBackendRegistry([
      new FfmpegBackend({
        ffmpeg: options.ffmpeg ?? process.env.AVE_FFMPEG ?? "ffmpeg",
        ffprobe: options.ffprobe ?? process.env.AVE_FFPROBE ?? "ffprobe",
      }),
    ]);

    const onProjectEvent = (projectId: string) => {
      this.ws?.notifyProjectEvents(projectId);
    };

    this.queries = new DaemonQueries(this.store, this.cas);
    this.planner = new AvePlannerController({
      store: this.store,
      queries: this.queries,
      onProjectEvent,
      providerDefaults: options.planner,
      workerEntryPath: options.plannerWorkerEntryPath,
    });
    this.jobs = new AveJobSupervisor(this.store, this.cas, this.backends, onProjectEvent);
    this.uploads = new UploadManager(this.store, this.cas, this.backends);
    this.rpc = new AveRpcRegistry({
      store: this.store,
      cas: this.cas,
      backends: this.backends,
      jobs: this.jobs,
      uploads: this.uploads,
      queries: this.queries,
      onProjectEvent,
      planner: this.planner,
    });
    this.ws = new AveWsServer({
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      ownerToken: this.ownerToken,
      store: this.store,
      rpc: this.rpc,
    });
  }

  ownerPrincipal(): EditorPrincipal {
    return { principalId: "owner", role: "owner", projectIds: null };
  }

  async start(): Promise<AveDaemonAddress> {
    this.store.jobs.reconcileInterruptedPlanningRuns(this.ownerPrincipal());
    this.jobs.start();
    const addr = await this.ws.start();
    this.addressInfo = {
      aveHome: this.aveHome,
      host: addr.host,
      port: addr.port,
      wsUrl: addr.wsUrl,
      healthUrl: addr.healthUrl,
      ownerToken: this.ownerToken,
    };
    return this.addressInfo;
  }

  get address(): AveDaemonAddress | undefined {
    return this.addressInfo;
  }

  async stop(): Promise<void> {
    await this.planner.disposeAll();
    await this.ws.stop();
    await this.jobs.stop();
    this.store.close();
  }
}
