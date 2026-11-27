import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  JobStateSchema,
  ObjectEditStateSchema,
  VideoToolCallSchema,
  decodeChunkMetadata,
  decodeFramedChunk,
  encodeFramedChunk,
} from "../src/index.js";
import * as contracts from "../src/v1.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R0_DIR = path.resolve(__dirname, "../../../conformance/r0-baseline");

interface FixtureCase {
  name: string;
  schema: string;
  valid: boolean;
  value: unknown;
}

describe("@ave/contracts R0 conformance", () => {
  const fixtures = JSON.parse(
    readFileSync(path.join(R0_DIR, "fixtures.json"), "utf8"),
  ) as FixtureCase[];
  const spec = JSON.parse(
    readFileSync(path.join(R0_DIR, "baseline-spec.json"), "utf8"),
  ) as {
    objectEditFsm: { states: string[] };
    jobStates: string[];
    errorCodes: string[];
    plannerTools: { allowed: string[] };
  };

  it("validates all 196 frozen R0 wire fixtures", () => {
    expect(fixtures).toHaveLength(196);
    for (const fixture of fixtures) {
      const schema = (contracts as Record<string, unknown>)[`${fixture.schema}Schema`];
      expect(schema, `Missing schema ${fixture.schema}Schema`).toBeDefined();
      const parsed = (schema as { safeParse: (v: unknown) => { success: boolean } }).safeParse(
        fixture.value,
      );
      expect(parsed.success, `Fixture "${fixture.name}" (${fixture.schema})`).toBe(fixture.valid);
    }
  });

  it("matches R0 baseline enums and planner tool surface", () => {
    expect(ObjectEditStateSchema.options).toEqual(spec.objectEditFsm.states);
    expect(JobStateSchema.options).toEqual(spec.jobStates);
    expect([...ERROR_CODES]).toEqual(spec.errorCodes);

    const toolNames = VideoToolCallSchema.options
      .map((opt) => (opt as { shape: { tool: { value: string } } }).shape.tool.value)
      .sort();
    expect(toolNames).toEqual([...spec.plannerTools.allowed].sort());
  });

  it("round-trips framed binary chunks and rejects malformed frames", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = encodeFramedChunk({ offset: "0", bytesLength: "5", protocolVersion: "1" }, payload);
    const decoded = decodeFramedChunk(frame);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4, 5]);
    expect(decodeChunkMetadata(frame)).toEqual({
      offset: "0",
      bytesLength: "5",
      protocolVersion: "1",
    });

    expect(() => decodeFramedChunk(new Uint8Array([0]))).toThrow();
    expect(() => decodeFramedChunk(new Uint8Array([0, 50, 1, 2]))).toThrow();
    expect(() =>
      encodeFramedChunk({ big: "x".repeat(70_000) }, new Uint8Array()),
    ).toThrow(RangeError);
  });
});
