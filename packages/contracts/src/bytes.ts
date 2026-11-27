export interface FramedChunk {
  metadata: Uint8Array;
  payload: Uint8Array;
}

export function encodeFramedChunk(
  metadata: Record<string, unknown>,
  payload: Uint8Array,
): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify(metadata));
  if (header.byteLength > 65_535) throw new RangeError("Video chunk metadata is too large");
  const frame = new Uint8Array(2 + header.byteLength + payload.byteLength);
  new DataView(frame.buffer).setUint16(0, header.byteLength);
  frame.set(header, 2);
  frame.set(payload, 2 + header.byteLength);
  return frame;
}

export function decodeFramedChunk(frame: Uint8Array): FramedChunk {
  if (frame.byteLength < 2) throw new TypeError("Video chunk frame is incomplete");
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(0);
  if (headerLength > frame.byteLength - 2) throw new TypeError("Video chunk header is incomplete");
  const metadata = new TextDecoder().decode(frame.subarray(2, 2 + headerLength));
  const parsed: unknown = JSON.parse(metadata);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Video chunk metadata must be an object");
  }
  return {
    metadata: new TextEncoder().encode(metadata),
    payload: frame.subarray(2 + headerLength),
  };
}

export function decodeChunkMetadata(frame: Uint8Array): Record<string, unknown> {
  const { metadata } = decodeFramedChunk(frame);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(metadata));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("Video chunk metadata must be an object");
  }
  return { ...parsed } as Record<string, unknown>;
}
