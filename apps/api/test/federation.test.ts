import { describe, expect, test } from "bun:test";
import { normalizeRelayUrl, peerRelayAllowed, peerRelayReachable, relayKey } from "../src/federation.ts";

describe("relay addresses", () => {
  test("one relay has one spelling", () => {
    expect(normalizeRelayUrl("https://api.gond.io")).toBe("https://api.gond.io");
    expect(normalizeRelayUrl("HTTPS://API.Gond.IO:443/")).toBe("https://api.gond.io");
    expect(normalizeRelayUrl(" https://api.gond.io./?x=1#top ")).toBe("https://api.gond.io");
    expect(normalizeRelayUrl("http://relay.lan:80")).toBe("http://relay.lan");
    expect(normalizeRelayUrl("http://relay.lan:8791/")).toBe("http://relay.lan:8791");
    expect(normalizeRelayUrl("https://example.com/Relay//")).toBe("https://example.com/Relay");
  });

  test("anything that isn't a plain http or https address has none", () => {
    expect(normalizeRelayUrl("ftp://relay.lan")).toBeNull();
    expect(normalizeRelayUrl("https://user:pass@relay.lan")).toBeNull();
    expect(normalizeRelayUrl("not a url")).toBeNull();
    expect(normalizeRelayUrl("javascript:alert(1)")).toBeNull();
  });

  test("an alias of this Gond's own relay is its own client", () => {
    const own = relayKey("https://api.gond.io");
    for (const alias of ["https://api.gond.io/", "HTTPS://api.GOND.io", "https://api.gond.io:443", "https://api.gond.io//?again"]) expect(relayKey(alias)).toBe(own);
    expect(relayKey("http://api.gond.io")).not.toBe(own);
    expect(relayKey("https://api.gond.io:8443")).not.toBe(own);
  });

  test("another Gond can't point this one at its own machine or network's insides", () => {
    for (const url of [
      "http://127.0.0.1:8791",
      "http://127.1.2.3",
      "http://2130706433",
      "http://0x7f.1",
      "http://0.0.0.0",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]:8791",
      "http://[::]",
      "http://[fe80::1]",
      "http://[febf::1]",
      "http://[::ffff:127.0.0.1]",
      "http://[::ffff:169.254.169.254]",
      "http://localhost:8791",
      "http://LOCALHOST.",
      "http://relay.localhost",
      "http://box:8790",
      "http://api",
      "https://user:pass@api.gond.io",
      "gopher://api.gond.io",
    ]) expect([url, peerRelayAllowed(url, "https://api.gond.io")]).toEqual([url, false]);
  });

  test("public and LAN relays are fine", () => {
    for (const url of [
      "https://api.gond.io",
      "http://relay.lan:8791",
      "http://192.168.1.20:8791",
      "http://10.0.0.5",
      "http://172.16.0.9",
      "http://100.64.1.2",
      "http://[fd00::5]:8791",
      "http://[2001:db8::1]",
      "https://relay.example.com/gond/",
    ]) expect([url, peerRelayAllowed(url, "https://api.gond.io")]).toEqual([url, true]);
  });

  test("this Gond's own relay is allowed wherever it is, in any spelling", () => {
    expect(peerRelayAllowed("http://127.0.0.1:8791/", "http://127.0.0.1:8791")).toBe(true);
    expect(peerRelayAllowed("http://RELAY:8791", "http://relay:8791/")).toBe(true);
    expect(peerRelayAllowed("http://127.0.0.1:8792", "http://127.0.0.1:8791")).toBe(false);
    expect(peerRelayAllowed("http://box:8790", null)).toBe(false);
  });

  test("DNS names resolving to loopback, unspecified, or link-local addresses are blocked", async () => {
    for (const addresses of [
      [{ address: "127.0.0.1" }],
      [{ address: "127.2.3.4" }],
      [{ address: "0.0.0.0" }],
      [{ address: "169.254.169.254" }],
      [{ address: "::1" }],
      [{ address: "::" }],
      [{ address: "fe80::1" }],
      [{ address: "fe80::1%eth0" }],
      [{ address: "::ffff:127.0.0.1" }],
      [{ address: "::ffff:169.254.169.254" }],
      [{ address: "::ffff:7f00:1" }],
      [{ address: "93.184.216.34" }, { address: "169.254.169.254" }],
      [],
    ]) {
      expect([
        addresses,
        await peerRelayReachable("https://relay.attacker.example", "https://api.gond.io", async () => addresses),
      ]).toEqual([addresses, false]);
    }

    expect(
      await peerRelayReachable("https://relay.attacker.example", "https://api.gond.io", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).toBe(false);
  });

  test("DNS names resolving to public or LAN addresses are allowed, and own relay or IP literals skip DNS", async () => {
    for (const addresses of [
      [{ address: "93.184.216.34" }],
      [{ address: "192.168.1.20" }],
      [{ address: "10.0.0.5" }],
      [{ address: "172.16.0.9" }],
      [{ address: "100.64.1.2" }],
      [{ address: "fd00::5" }],
      [{ address: "2001:db8::1" }],
      [{ address: "::ffff:192.168.1.20" }],
    ]) {
      expect([
        addresses,
        await peerRelayReachable("https://relay.example.com", "https://api.gond.io", async () => addresses),
      ]).toEqual([addresses, true]);
    }

    let lookedUp = 0;
    const countingLookup = async () => {
      lookedUp += 1;
      return [{ address: "127.0.0.1" }];
    };
    expect(await peerRelayReachable("http://127.0.0.1:8791/", "http://127.0.0.1:8791", countingLookup)).toBe(true);
    expect(await peerRelayReachable("http://relay:8791", "http://relay:8791/", countingLookup)).toBe(true);
    expect(await peerRelayReachable("http://192.168.1.20:8791", "https://api.gond.io", countingLookup)).toBe(true);
    expect(await peerRelayReachable("http://[fd00::5]:8791", "https://api.gond.io", countingLookup)).toBe(true);
    expect(lookedUp).toBe(0);
  });
});
