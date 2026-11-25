import { describe, expect, it } from "vitest";
import {
  ConnectionOfferV2Schema,
  decodeOfferFragmentPayload,
  parseConnectionOfferFromUrl,
} from "./connection-offer.js";

// Complements the upstream connection-offer.test.ts: covers the malformed-payload
// and schema-rejection paths of the relay pairing offer (goal: phone/relay device
// pairing must fail closed, never silently accept a bad offer).

const validOffer = {
  v: 2,
  serverId: "srv_test",
  daemonPublicKeyB64: "abc",
  relay: { endpoint: "relay.paseo.sh:443", useTls: true },
};

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("decodeOfferFragmentPayload failure paths", () => {
  it("throws on invalid UTF-8 bytes (fatal decoder)", () => {
    const badUtf8 = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64url");
    expect(() => decodeOfferFragmentPayload(badUtf8)).toThrow();
  });

  it("throws on base64url that decodes to non-JSON text", () => {
    const notJson = Buffer.from("not json", "utf8").toString("base64url");
    expect(() => decodeOfferFragmentPayload(notJson)).toThrow();
  });
});

describe("parseConnectionOfferFromUrl fail-closed", () => {
  it("returns null for empty, whitespace-only and fragment-less input", () => {
    expect(parseConnectionOfferFromUrl("")).toBeNull();
    expect(parseConnectionOfferFromUrl("   ")).toBeNull();
    expect(parseConnectionOfferFromUrl("https://app.paseo.sh/")).toBeNull();
    expect(parseConnectionOfferFromUrl("https://app.paseo.sh/#offer=")).toBeNull();
    expect(parseConnectionOfferFromUrl("https://app.paseo.sh/#offer=   ")).toBeNull();
  });

  it("throws when the fragment exists but fails schema validation", () => {
    const wrongVersion = encode({ ...validOffer, v: 1 });
    expect(() => parseConnectionOfferFromUrl(`https://app.paseo.sh/#offer=${wrongVersion}`)).toThrow();
    const missingServerId = encode({ ...validOffer, serverId: "" });
    expect(() => parseConnectionOfferFromUrl(`https://app.paseo.sh/#offer=${missingServerId}`)).toThrow();
  });

  it("parses a valid protected offer from a QR-style URL", () => {
    const url = `https://app.paseo.sh/#offer=${encode({ ...validOffer, minimumSecurityMode: "protected" })}`;
    expect(parseConnectionOfferFromUrl(url)).toEqual({ ...validOffer, minimumSecurityMode: "protected" });
  });
});

describe("ConnectionOfferV2Schema gates", () => {
  it("requires v=2 and a non-empty serverId/key/endpoint", () => {
    expect(ConnectionOfferV2Schema.safeParse(validOffer).success).toBe(true);
    expect(ConnectionOfferV2Schema.safeParse({ ...validOffer, v: 1 }).success).toBe(false);
    expect(ConnectionOfferV2Schema.safeParse({ ...validOffer, serverId: "" }).success).toBe(false);
    expect(ConnectionOfferV2Schema.safeParse({ ...validOffer, daemonPublicKeyB64: "" }).success).toBe(false);
    expect(ConnectionOfferV2Schema.safeParse({ ...validOffer, relay: { endpoint: "" } }).success).toBe(false);
  });

  it("only accepts the protected minimum security mode literal", () => {
    expect(ConnectionOfferV2Schema.safeParse({ ...validOffer, minimumSecurityMode: "protected" }).success).toBe(true);
    expect(ConnectionOfferV2Schema.safeParse({ ...validOffer, minimumSecurityMode: "legacy" }).success).toBe(false);
  });
});