import { describe, expect, it } from "vitest";
import { EditorError, describeEditorError, editorFailure } from "./errors.js";

describe("editor error sanitization", () => {
  it("passes through an EditorError's code, retryable flag and sanitized detail", () => {
    expect(describeEditorError(new EditorError("QA_FAILED", "Candidate audio tracks differ", true))).toEqual({
      code: "QA_FAILED",
      retryable: true,
      sanitizedDetail: "Candidate audio tracks differ",
    });
    expect(describeEditorError(new EditorError("PERMISSION_DENIED", "denied"))).toEqual({
      code: "PERMISSION_DENIED",
      retryable: false,
      sanitizedDetail: "denied",
    });
  });

  it("never leaks internal detail from a non-EditorError", () => {
    const sensitive = new Error("SQLITE_ERROR: no such table at /home/secret/db.sqlite");
    expect(describeEditorError(sensitive)).toEqual({
      code: "INTERNAL",
      retryable: false,
      sanitizedDetail: "The video service could not complete the request",
    });
    // Thrown strings / plain objects are sanitized identically.
    for (const thrown of ["raw failure", { secret: "/etc/passwd" }, null, undefined]) {
      expect(describeEditorError(thrown)).toEqual({
        code: "INTERNAL",
        retryable: false,
        sanitizedDetail: "The video service could not complete the request",
      });
    }
  });

  it("editorFailure throws an EditorError carrying the code", () => {
    expect(() => editorFailure("CAPABILITY_UNAVAILABLE", "one FFmpeg trim only")).toThrow(EditorError);
    try {
      editorFailure("CANCELLED", "cancelled", true);
    } catch (error) {
      expect(error).toBeInstanceOf(EditorError);
      expect((error as EditorError).code).toBe("CANCELLED");
      expect((error as EditorError).retryable).toBe(true);
    }
  });
});