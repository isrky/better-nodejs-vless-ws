export function base64UrlToBytes(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Big-endian 16-bit length prefix followed by the payload. */
export function lengthPrefixed(payload) {
  const out = new Uint8Array(2 + payload.byteLength);
  out[0] = (payload.byteLength >>> 8) & 0xff;
  out[1] = payload.byteLength & 0xff;
  out.set(payload, 2);
  return out;
}
