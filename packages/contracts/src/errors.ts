export const ERROR_CODES = [
  "APPROVAL_CONSUMED",
  "APPROVAL_EXPIRED",
  "ARTIFACT_HASH_MISMATCH",
  "ASSET_NOT_FOUND",
  "CANCELLED",
  "CAPABILITY_UNAVAILABLE",
  "IDEMPOTENCY_CONFLICT",
  "INTERNAL",
  "INVALID_ARGUMENT",
  "NEEDS_RECONCILIATION",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "PLAN_SEMANTIC_INVALID",
  "PROJECT_NOT_FOUND",
  "QA_FAILED",
  "RANGE_NOT_SATISFIABLE",
  "RESOURCE_EXHAUSTED",
  "REVISION_CONFLICT",
  "SCHEMA_UNSUPPORTED",
  "UNAUTHENTICATED",
  "UPSTREAM_UNAVAILABLE",
  "WORKER_BUSY",
  "WORKER_FAILED",
  "WORKFLOW_STATE",
] as const;

export type AveErrorCode = (typeof ERROR_CODES)[number];

export class EditorError extends Error {
  constructor(
    readonly code: AveErrorCode | (string & {}),
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "EditorError";
  }
}

export function editorFailure(
  code: AveErrorCode | (string & {}),
  sanitizedDetail: string,
  retryable = false,
): never {
  throw new EditorError(code, sanitizedDetail, retryable);
}

export function describeEditorError(error: unknown): {
  code: string;
  retryable: boolean;
  sanitizedDetail: string;
} {
  if (error instanceof EditorError) {
    return { code: error.code, retryable: error.retryable, sanitizedDetail: error.message };
  }
  return {
    code: "INTERNAL",
    retryable: false,
    sanitizedDetail: "The video service could not complete the request",
  };
}
