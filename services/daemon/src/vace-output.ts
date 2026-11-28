import { open, readFile } from "node:fs/promises";
import path from "node:path";
import type { ContentAddressedStore } from "@ave/cas";
import { editorFailure, VACE_MODEL, type BlobRef } from "@ave/contracts";

export async function verifyGeneratedPixels(directory: string, cas: ContentAddressedStore,
  frames: { label: BlobRef; foregroundPixels: number }[], width: number, height: number, seed: number) {
  const report = JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"));
  if (report.modelRevision !== VACE_MODEL || report.steps !== 20 || report.seed !== seed ||
      report.changedPixels?.length !== frames.length || report.protectedPixels?.length !== frames.length) {
    editorFailure("QA_FAILED", "Unexpected VACE model, seed, steps or frame report");
  }
  const source = await open(path.join(directory, "source.rgb"));
  try {
    const output = await open(path.join(directory, "composite.rgb"));
    try {
      const pixels = width * height;
      const size = frames.length * pixels * 3;
      if ((await source.stat()).size !== size || (await output.stat()).size !== size) {
        editorFailure("QA_FAILED", "VACE output frame geometry or count changed");
      }
      const before = Buffer.alloc(pixels * 3), after = Buffer.alloc(pixels * 3);
      const changedPixels: number[] = [];
      for (const [i, frame] of frames.entries()) {
        const label = await cas.readBytes(frame.label);
        if (label.length !== pixels) editorFailure("QA_FAILED", "Approved label geometry changed");
        const offset = i * pixels * 3;
        if ((await source.read(before, 0, before.length, offset)).bytesRead !== before.length ||
            (await output.read(after, 0, after.length, offset)).bytesRead !== after.length) {
          editorFailure("QA_FAILED", "Incomplete generated raster");
        }
        let changed = 0, foreground = 0;
        for (let p = 0; p < pixels; p++) {
          if (label[p] !== 0 && label[p] !== 255) editorFailure("QA_FAILED", "Nonbinary approved label");
          if (label[p]) foreground++;
          const c = p * 3;
          if (before[c] === after[c] && before[c+1] === after[c+1] && before[c+2] === after[c+2]) continue;
          if (!label[p]) editorFailure("QA_FAILED", "Generated shot changed protected pixels");
          changed++;
        }
        if (foreground !== frame.foregroundPixels || changed !== report.changedPixels[i] ||
            pixels - foreground !== report.protectedPixels[i]) editorFailure("QA_FAILED", "Generated pixel report mismatch");
        changedPixels.push(changed);
      }
      if (!changedPixels.some(n => n > 0)) editorFailure("QA_FAILED", "No pixels changed inside the approved mask");
      return changedPixels;
    } finally { await output.close(); }
  } finally { await source.close(); }
}
