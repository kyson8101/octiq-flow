// base64url, which is what Web Push is written in.
//
// Not the same alphabet as `atob`/`btoa`: `+` and `/` become `-` and `_`, and
// the `=` padding is dropped. Three characters of difference, and getting them
// wrong is silent — `subscribe()` still resolves, the server still stores a
// row, and no notification ever arrives.
//
// Its own file, with nothing imported, because these two are pure data and the
// rest of `push.ts` is service workers and a socket. That keeps them testable
// in a runner with no DOM.

/** base64url text → the bytes it stands for.
 *
 *  Returns the ArrayBuffer rather than a view over it: `applicationServerKey`
 *  is typed `BufferSource`, and a `Uint8Array` is generic over a buffer that
 *  might be shared — which that type does not accept. */
export function fromBase64Url(text: string): ArrayBuffer {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  // `atob` refuses a string whose length is not a multiple of four, so the
  // padding base64url leaves off has to be put back.
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const raw = atob(padded);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return buffer;
}

/** Bytes → base64url text. `null` gives "", since that is what the browser
 *  hands back for a key a subscription does not carry. */
export function toBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
