/**
 * Swarm CIDs: bzz.link serves content on a subdomain, and a DNS label is limited to 63 characters,
 * so a 64-hex Swarm reference is re-encoded as a CIDv1:
 *   0x01 | swarm-manifest codec (0xfa 0x01) | keccak-256 multihash (0x1b 0x20) | 32-byte hash,
 * base32 (lowercase, no padding) with a 'b' multibase prefix. The result looks like "bah5acgza...".
 */
import { fromHex } from "./bytes";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function isSwarmRef(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s);
}

/** 64-hex reference -> CIDv1 string, for `https://<cid>.bzz.link/`. */
export function refToCid(ref: string): string {
  if (!isSwarmRef(ref)) throw new Error("not a 64-character Swarm reference");
  const prefix = Uint8Array.from([0x01, 0xfa, 0x01, 0x1b, 0x20]);
  const hash = fromHex(ref);
  const all = new Uint8Array(prefix.length + hash.length);
  all.set(prefix);
  all.set(hash, prefix.length);
  return "b" + base32(all);
}
