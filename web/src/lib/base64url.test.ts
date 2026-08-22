// The base64url conversions, which fail silently when they are wrong.
//
// Everything else in push.ts talks to a service worker or a push service and
// cannot run here. These two can, and they are the pair most worth pinning:
// Web Push is written in base64url throughout, `atob`/`btoa` speak plain
// base64, and the difference is three characters — `+/=` against `-_` and no
// padding. Get it wrong and `subscribe()` still resolves, the server still
// stores a row, and no notification ever arrives.
import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url } from "./base64url";

/** A real VAPID public key is 65 bytes: the 0x04 tag and two 32-byte halves. */
const APPLICATION_SERVER_KEY =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

describe("fromBase64Url", () => {
  it("decodes a server key to the 65 bytes a P-256 point is", () => {
    const bytes = new Uint8Array(fromBase64Url(APPLICATION_SERVER_KEY));
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });

  it("reads the url-safe alphabet, not the standard one", () => {
    // `-` and `_` stand where `+` and `/` do in plain base64. Decoded as plain
    // base64 this throws or yields different bytes; either way the key is not
    // the server's, and the push service rejects every send made with it.
    const bytes = new Uint8Array(fromBase64Url("-_-_"));
    expect(Array.from(bytes)).toEqual([251, 255, 191]);
  });

  it("supplies the padding base64url leaves off", () => {
    // Three bytes of input is four characters and needs none; two bytes is
    // three characters and needs one `=`. `atob` refuses a string of the wrong
    // length, so the padding has to be put back.
    expect(new Uint8Array(fromBase64Url("AAA")).length).toBe(2);
    expect(new Uint8Array(fromBase64Url("AAAA")).length).toBe(3);
  });
});

describe("toBase64Url", () => {
  it("comes back to what it started as", () => {
    expect(toBase64Url(fromBase64Url(APPLICATION_SERVER_KEY))).toBe(APPLICATION_SERVER_KEY);
  });

  it("emits the url-safe alphabet and no padding", () => {
    const encoded = toBase64Url(new Uint8Array([251, 243, 253]).buffer);
    expect(encoded).toBe("-_P9");
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("gives nothing back for a key the browser did not supply", () => {
    // `getKey` returns null for a subscription that has no such key, and the
    // fallback path hands that straight here.
    expect(toBase64Url(null)).toBe("");
  });
});
