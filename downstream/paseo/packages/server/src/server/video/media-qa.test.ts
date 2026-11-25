import { describe, expect, it } from "vitest";
import { assertCandidateAudio, parsePresentationFrames } from "./media.js";

const aac = (channels: number) => ({
  codec_type: "audio",
  codec_name: "aac",
  sample_rate: "48000",
  channels,
});

describe("assertCandidateAudio", () => {
  it("accepts audio matching the approved render profile", () => {
    expect(() =>
      assertCandidateAudio([{ kind: "audio", channels: 2 }], [aac(2)] as never),
    ).not.toThrow();
    // A video-only source requires no audio tracks.
    expect(() =>
      assertCandidateAudio([{ kind: "video" }], [{ codec_type: "video" }] as never),
    ).not.toThrow();
  });

  it("rejects wrong track count, codec, sample rate or channels", () => {
    const source = [{ kind: "audio", channels: 2 }];
    expect(() => assertCandidateAudio(source, [] as never)).toThrow("audio tracks differ");
    expect(() =>
      assertCandidateAudio(source, [{ ...aac(2), codec_name: "mp3" }] as never),
    ).toThrow("audio tracks differ");
    expect(() =>
      assertCandidateAudio(source, [{ ...aac(2), sample_rate: "44100" }] as never),
    ).toThrow("audio tracks differ");
    expect(() => assertCandidateAudio(source, [aac(1)] as never)).toThrow("audio tracks differ");
    expect(() =>
      assertCandidateAudio(source, [{ ...aac(2), channels: undefined }] as never),
    ).toThrow("audio tracks differ");
    // An extra output track is also a mismatch.
    expect(() => assertCandidateAudio(source, [aac(2), aac(2)] as never)).toThrow(
      "audio tracks differ",
    );
  });
});

describe("parsePresentationFrames", () => {
  it("preserves int64 frame ticks as exact string tokens beyond 2^53", () => {
    const frames = parsePresentationFrames(
      '{"frames":[{"pts":9007199254740993,"duration":40,"best_effort_timestamp":9007199254740993}]}',
    ) as Array<Record<string, unknown>>;
    expect(frames[0]!.pts).toBe("9007199254740993");
    expect(frames[0]!.best_effort_timestamp).toBe("9007199254740993");
    expect(frames[0]!.duration).toBe("40");
  });

  it("preserves negative ticks and leaves non-tick fields as numbers", () => {
    const frames = parsePresentationFrames(
      '{"frames":[{"pts":-5,"width":96,"height":64}]}',
    ) as Array<Record<string, unknown>>;
    expect(frames[0]!.pts).toBe("-5");
    expect(frames[0]!.width).toBe(96);
    expect(frames[0]!.height).toBe(64);
  });

  it("rejects a missing frame list and non-integer tick tokens", () => {
    expect(() => parsePresentationFrames('{"streams":[]}')).toThrow("No decoded frame list");
    expect(() => parsePresentationFrames('{"frames":[{"pts":1.5}]}')).toThrow(
      "No exact integer token",
    );
  });
});