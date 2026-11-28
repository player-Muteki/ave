import { describe, expect, it } from "vitest";
import { helpSupportsFpsMode } from "../src/media-flags.js";

describe("FFmpeg output timing capability detection", () => {
  it("uses fps_mode only when the executable actually advertises it", () => {
    expect(helpSupportsFpsMode("  -vsync            video sync method\n  -fps_mode vfr     set framerate mode\n")).toBe(true);
    expect(helpSupportsFpsMode("-fps_mode[:<stream_spec>]  set framerate mode\n")).toBe(true);
    expect(helpSupportsFpsMode("  -vsync            video sync method\n  -enc_time_base:v  set encoder time base\n")).toBe(false);
  });

  it("does not mistake unrelated text for the real CLI option", () => {
    expect(helpSupportsFpsMode("documentation mentions -fps_mode but the parser does not support it")).toBe(false);
  });
});
