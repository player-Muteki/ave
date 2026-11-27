import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialization with lexicographically sorted object keys
 * so hashes do not change when fields are serialized in different orders.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
