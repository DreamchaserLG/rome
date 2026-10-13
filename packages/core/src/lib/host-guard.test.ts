import { describe, expect, it } from "@rstest/core";
import { isAllowedInternalHost } from "./host-guard.js";

describe("isAllowedInternalHost", () => {
  it.each([
    ["127.0.0.1:4141"],
    ["localhost:4141"],
    ["localhost"],
    ["LOCALHOST:4141"],
    ["rome.localhost"],
    ["inbox.rome.localhost:3000"],
    ["[::1]:4141"],
    ["192.0.2.10:4141"],
    ["127.1.2.3:4141"],
    ["[2001:db8::1]:4141"],
    ["box.tail1234.ts.net"],
    ["box.tail1234.ts.net:443"],
  ])("allows %s", (host) => {
    expect(isAllowedInternalHost(host)).toBe(true);
  });

  it("allows a request with no Host header", () => {
    expect(isAllowedInternalHost(undefined)).toBe(true);
  });

  it.each([
    ["rebind.example:4141"],
    ["rebind.example"],
    ["localhost.evil.example"],
    ["127.0.0.1.evil.example"],
    ["evil.example.ts.net.attacker.example"],
    ["ts.net"],
    ["rebind.example@127.0.0.1"],
    ["127.0.0.1/rebind.example"],
    ["localhost:4141:4141"],
  ])("refuses %s", (host) => {
    expect(isAllowedInternalHost(host)).toBe(false);
  });
});
