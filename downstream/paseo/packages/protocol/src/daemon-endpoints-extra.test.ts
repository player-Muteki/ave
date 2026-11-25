import { describe, expect, it } from "vitest";
import {
  deriveLabelFromEndpoint,
  extractHostPortFromWebSocketUrl,
  isRelayClientWebSocketUrl,
  normalizeHostPort,
  normalizeLoopbackToLocalhost,
  parseHostPort,
} from "./daemon-endpoints.js";

// Complements the upstream daemon-endpoints.test.ts: covers the host:port
// primitives, loopback normalization, relay-client detection and WebSocket
// host extraction paths that the device/relay connection guard relies on.

describe("parseHostPort primitives", () => {
  it("parses host:port and bracketed IPv6", () => {
    expect(parseHostPort("localhost:6767")).toEqual({ host: "localhost", port: 6767, isIpv6: false });
    expect(parseHostPort("[::1]:6767")).toEqual({ host: "::1", port: 6767, isIpv6: true });
  });

  it("rejects out-of-range ports", () => {
    expect(() => parseHostPort("localhost:0")).toThrow(/port must be between 1 and 65535/);
    expect(() => parseHostPort("localhost:65536")).toThrow(/port must be between 1 and 65535/);
  });

  it("rejects missing port, empty host and unbracketed IPv6 without port", () => {
    expect(() => parseHostPort("localhost")).toThrow(/Invalid host:port/);
    expect(() => parseHostPort("")).toThrow(/Host is required/);
    expect(() => parseHostPort("[::1]")).toThrow(/Invalid host:port/);
  });

  it("normalizeHostPort re-brackets IPv6 and keeps host:port stable", () => {
    expect(normalizeHostPort("[::1]:6767")).toBe("[::1]:6767");
    expect(normalizeHostPort("localhost:6767")).toBe("localhost:6767");
  });
});

describe("normalizeLoopbackToLocalhost", () => {
  it("maps every loopback form to localhost", () => {
    expect(normalizeLoopbackToLocalhost("127.0.0.1:6767")).toBe("localhost:6767");
    expect(normalizeLoopbackToLocalhost("0.0.0.0:6767")).toBe("localhost:6767");
    expect(normalizeLoopbackToLocalhost("[::1]:6767")).toBe("localhost:6767");
    expect(normalizeLoopbackToLocalhost("[::]:6767")).toBe("localhost:6767");
  });

  it("leaves non-loopback endpoints untouched", () => {
    expect(normalizeLoopbackToLocalhost("192.168.1.5:6767")).toBe("192.168.1.5:6767");
    expect(normalizeLoopbackToLocalhost("relay.paseo.sh:443")).toBe("relay.paseo.sh:443");
  });
});

describe("deriveLabelFromEndpoint", () => {
  it("extracts the host and falls back on invalid input", () => {
    expect(deriveLabelFromEndpoint("localhost:6767")).toBe("localhost");
    expect(deriveLabelFromEndpoint("[::1]:6767")).toBe("::1");
    expect(deriveLabelFromEndpoint("garbage")).toBe("Unnamed Host");
  });
});

describe("isRelayClientWebSocketUrl", () => {
  it("requires both role=client and a serverId", () => {
    expect(isRelayClientWebSocketUrl("wss://relay/ws?role=client&serverId=s")).toBe(true);
    expect(isRelayClientWebSocketUrl("wss://relay/ws?role=server&serverId=s")).toBe(false);
    expect(isRelayClientWebSocketUrl("wss://relay/ws?role=client")).toBe(false);
    expect(isRelayClientWebSocketUrl("wss://relay/ws?serverId=s")).toBe(false);
  });

  it("returns false for an unparseable url", () => {
    expect(isRelayClientWebSocketUrl("not a url")).toBe(false);
  });
});

describe("extractHostPortFromWebSocketUrl", () => {
  it("applies scheme default ports and tolerates a trailing slash", () => {
    expect(extractHostPortFromWebSocketUrl("ws://localhost:6767/ws")).toBe("localhost:6767");
    expect(extractHostPortFromWebSocketUrl("wss://relay.paseo.sh/ws")).toBe("relay.paseo.sh:443");
    expect(extractHostPortFromWebSocketUrl("ws://host/ws")).toBe("host:80");
    expect(extractHostPortFromWebSocketUrl("ws://host:6767/ws/")).toBe("host:6767");
  });

  it("rejects non-ws protocols and non-/ws paths", () => {
    expect(() => extractHostPortFromWebSocketUrl("http://host/ws")).toThrow(/Invalid WebSocket URL protocol/);
    expect(() => extractHostPortFromWebSocketUrl("ws://host/other")).toThrow(/expected \/ws path/);
  });
});