import type { ContentAddressedStore } from "@ave/cas";
import {
  editorFailure,
  type AcceptedEditPlan,
  type ArtifactRef,
  type BlobRef,
  type JobSnapshot,
  type Rational,
  type SourceAsset,
} from "@ave/contracts";

export interface ProbeAndIndexResult {
  asset: SourceAsset;
  constantRateStreamUids: string[];
}

export interface GeneratedShot {
  path: string;
  width: number;
  height: number;
  rate: Rational;
  trace: {
    modelRevision: string; seed: number; promptHash: string; maskHash: string;
    sourceRgbHash: string; compositeHash: string; sourcePts: string[]; changedPixels: number[];
  };
}
export type GenerateShot = (plan: AcceptedEditPlan, directory: string, signal: AbortSignal) => Promise<GeneratedShot>;

export interface RenderPlanResult {
  candidate: ArtifactRef;
  qa: ArtifactRef;
  reviewProxy?: ArtifactRef;
}

export interface AnalysisArtifactsResult {
  analysisQa: ArtifactRef;
  sceneCuts: ArtifactRef;
  waveform?: ArtifactRef;
  units: number;
}

export interface ContactSheetData {
  columns: number;
  rows: number;
  tiles: number;
  tileWidth: number;
  tileHeight: number;
  tileSourceSeconds: string[];
  blob: BlobRef;
}

export interface DeterministicBackend {
  readonly id: "ffmpeg" | "filmcraft";
  isAvailable(): Promise<boolean>;
  ffmpegVersion(): Promise<string | undefined>;
  burnInSubtitlesAvailable(): Promise<boolean>;
  probeAndIndex(input: {
    assetId: string;
    displayName: string;
    originalBlob: BlobRef;
    cas: ContentAddressedStore;
  }): Promise<ProbeAndIndexResult>;
  renderPlan(input: {
    job: JobSnapshot;
    plan: AcceptedEditPlan;
    generateShot?: GenerateShot;
    assets: Map<string, SourceAsset>;
    cas: ContentAddressedStore;
    signal: AbortSignal;
  }): Promise<RenderPlanResult>;
  deliverExport(input: {
    job: JobSnapshot;
    plan: AcceptedEditPlan;
    candidate: ArtifactRef;
    qa: ArtifactRef;
    cas: ContentAddressedStore;
    signal: AbortSignal;
  }): Promise<{ output: ArtifactRef; manifest: ArtifactRef }>;
  analyzeAsset(input: {
    job: JobSnapshot;
    asset: SourceAsset;
    cas: ContentAddressedStore;
    rate: string;
    signal: AbortSignal;
  }): Promise<AnalysisArtifactsResult>;
  contactSheet(input: {
    asset: SourceAsset;
    maxTiles: number;
    cas: ContentAddressedStore;
    signal: AbortSignal;
  }): Promise<ContactSheetData>;
  previewFrames(input: {
    candidate: ArtifactRef;
    maxTiles: number;
    cas: ContentAddressedStore;
    signal: AbortSignal;
  }): Promise<ContactSheetData>;
}

export class DeterministicBackendRegistry {
  private readonly backends = new Map<string, DeterministicBackend>();

  constructor(initial: readonly DeterministicBackend[] = []) {
    for (const backend of initial) {
      this.backends.set(backend.id, backend);
    }
  }

  get(id: "ffmpeg" | "filmcraft"): DeterministicBackend {
    const backend = this.backends.get(id);
    if (!backend) {
      editorFailure(
        "CAPABILITY_UNAVAILABLE",
        `Deterministic backend "${id}" is not enabled in this native AVE runtime`,
      );
    }
    return backend;
  }

  async capabilities(): Promise<
    Array<{ id: "ffmpeg" | "filmcraft"; available: boolean; reason?: string; version?: string }>
  > {
    const ffmpeg = this.backends.get("ffmpeg");
    const ffmpegAvailable = ffmpeg ? await ffmpeg.isAvailable() : false;
    const ffmpegVersion = ffmpegAvailable && ffmpeg ? await ffmpeg.ffmpegVersion() : undefined;
    return [
      {
        id: "ffmpeg",
        available: ffmpegAvailable,
        ...(ffmpegVersion ? { version: ffmpegVersion } : {}),
        ...(!ffmpegAvailable ? { reason: "ffmpeg executable not found" } : {}),
      },
      {
        id: "filmcraft",
        available: false,
        reason: "FilmCraft removed from native AVE v1 critical path (ADR 012)",
      },
    ];
  }
}

export type { Rational };
