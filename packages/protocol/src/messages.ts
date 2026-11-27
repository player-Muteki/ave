import { z } from "zod";
import {
  EditorErrorSchema,
  EditorEventSchema,
  EditorPrincipalSchema,
} from "@ave/contracts";

export const AVE_WS_PROTOCOL_VERSION = "1" as const;

export const WsAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("localOwner"), token: z.string().min(1).max(512) }).strict(),
  z
    .object({
      kind: z.literal("device"),
      deviceId: z.string().min(1).max(128),
      credential: z.string().min(1).max(512),
    })
    .strict(),
]);
export type WsAuth = z.infer<typeof WsAuthSchema>;

export const WsHelloSchema = z
  .object({
    kind: z.literal("hello"),
    protocolVersion: z.literal(AVE_WS_PROTOCOL_VERSION),
    auth: WsAuthSchema,
  })
  .strict();

export const WsHelloAckSchema = z
  .object({
    kind: z.literal("hello_ack"),
    protocolVersion: z.literal(AVE_WS_PROTOCOL_VERSION),
    principal: EditorPrincipalSchema,
    serverTime: z.string().datetime(),
  })
  .strict();

export const WsRequestSchema = z
  .object({
    kind: z.literal("request"),
    id: z.string().min(1).max(128),
    method: z.string().min(1).max(128),
    input: z.unknown().optional(),
    binaryBase64: z.string().optional(),
  })
  .strict();

export const WsResponseSchema = z
  .object({
    kind: z.literal("response"),
    id: z.string().min(1).max(128),
    ok: z.literal(true),
    result: z.unknown().optional(),
    binaryBase64: z.string().optional(),
  })
  .strict();

export const WsErrorSchema = z
  .object({
    kind: z.literal("error"),
    id: z.string().min(1).max(128).optional(),
    ok: z.literal(false),
    error: EditorErrorSchema,
  })
  .strict();

export const WsSubscribeSchema = z
  .object({
    kind: z.literal("subscribe"),
    projectId: z.string().min(1).max(128),
    afterSeq: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(),
  })
  .strict();

export const WsUnsubscribeSchema = z
  .object({
    kind: z.literal("unsubscribe"),
    projectId: z.string().min(1).max(128),
  })
  .strict();

export const WsEventPushSchema = z
  .object({
    kind: z.literal("event"),
    event: EditorEventSchema,
  })
  .strict();

export const WsClientMessageSchema = z.discriminatedUnion("kind", [
  WsHelloSchema,
  WsRequestSchema,
  WsSubscribeSchema,
  WsUnsubscribeSchema,
]);

export const WsServerMessageSchema = z.discriminatedUnion("kind", [
  WsHelloAckSchema,
  WsResponseSchema,
  WsErrorSchema,
  WsEventPushSchema,
]);

export type WsHello = z.infer<typeof WsHelloSchema>;
export type WsHelloAck = z.infer<typeof WsHelloAckSchema>;
export type WsRequest = z.infer<typeof WsRequestSchema>;
export type WsResponse = z.infer<typeof WsResponseSchema>;
export type WsError = z.infer<typeof WsErrorSchema>;
export type WsSubscribe = z.infer<typeof WsSubscribeSchema>;
export type WsUnsubscribe = z.infer<typeof WsUnsubscribeSchema>;
export type WsEventPush = z.infer<typeof WsEventPushSchema>;
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

/**
 * Binary WebSocket frame envelope:
 * [uint16BE correlationIdLen][utf8 correlationId][utf8 methodLen + method (uint8)][payload]
 */
export function encodeWsBinaryFrame(
  correlationId: string,
  method: string,
  payload: Uint8Array,
): Uint8Array {
  const idBytes = new TextEncoder().encode(correlationId);
  const methodBytes = new TextEncoder().encode(method);
  if (idBytes.byteLength === 0 || idBytes.byteLength > 65_535) {
    throw new RangeError("Invalid binary frame correlation id length");
  }
  if (methodBytes.byteLength > 255) {
    throw new RangeError("Invalid binary frame method length");
  }
  const frame = new Uint8Array(3 + idBytes.byteLength + methodBytes.byteLength + payload.byteLength);
  new DataView(frame.buffer).setUint16(0, idBytes.byteLength);
  frame.set(idBytes, 2);
  frame[2 + idBytes.byteLength] = methodBytes.byteLength;
  frame.set(methodBytes, 3 + idBytes.byteLength);
  frame.set(payload, 3 + idBytes.byteLength + methodBytes.byteLength);
  return frame;
}

export function decodeWsBinaryFrame(frame: Uint8Array): {
  correlationId: string;
  method: string;
  payload: Uint8Array;
} {
  if (frame.byteLength < 3) throw new TypeError("Incomplete WS binary frame");
  const idLen = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(0);
  if (idLen === 0 || 3 + idLen > frame.byteLength) {
    throw new TypeError("Malformed WS binary frame correlation id");
  }
  const correlationId = new TextDecoder().decode(frame.subarray(2, 2 + idLen));
  const methodLen = frame[2 + idLen]!;
  if (3 + idLen + methodLen > frame.byteLength) {
    throw new TypeError("Malformed WS binary frame method");
  }
  const method = new TextDecoder().decode(frame.subarray(3 + idLen, 3 + idLen + methodLen));
  const payload = frame.subarray(3 + idLen + methodLen);
  return { correlationId, method, payload };
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(encoded, "base64"));
  }
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
