import { secp256k1 } from "@noble/curves/secp256k1.js";
import { fromHex, keccak, sha256Hex, strip0x, toHex, utf8 } from "./bytes";
import { SCHEMA_VERSION, type Seal } from "./types";

/** Ethereum-style address (lowercase hex, no 0x) of a private key. */
export function addressOf(privateKeyHex: string): string {
  const pub = secp256k1.getPublicKey(fromHex(privateKeyHex), false); // 65 bytes, 0x04 prefix
  return toHex(keccak(pub.slice(1)).slice(12));
}

function digestFor(owner: string, version: number, publishedAt: string, postsHash: string): Uint8Array {
  return keccak(utf8(`parcha-seal-v1\n${owner}\n${version}\n${publishedAt}\n${postsHash}`));
}

export function createSeal(privateKeyHex: string, version: number, publishedAt: string, postsBytes: Uint8Array): Seal {
  const owner = addressOf(privateKeyHex);
  const postsHash = sha256Hex(postsBytes);
  const sig = secp256k1.sign(digestFor(owner, version, publishedAt, postsHash), fromHex(privateKeyHex), {
    prehash: false,
    format: "recovered",
  });
  return { schema: SCHEMA_VERSION, owner, version, publishedAt, postsHash, signature: toHex(sig) };
}

export type SealCheck = { ok: true } | { ok: false; reason: string };

/** Verify that `seal` was signed by `expectedOwner` and covers exactly `postsBytes`. */
export function verifySeal(seal: Seal, postsBytes: Uint8Array, expectedOwner: string): SealCheck {
  try {
    const owner = strip0x(expectedOwner).toLowerCase();
    if (seal.owner.toLowerCase() !== owner) return { ok: false, reason: "seal owner differs from the site's feed owner" };
    if (sha256Hex(postsBytes) !== seal.postsHash) return { ok: false, reason: "posts.json does not match the signed hash" };
    const digest = digestFor(seal.owner, seal.version, seal.publishedAt, seal.postsHash);
    const pub = secp256k1.recoverPublicKey(fromHex(seal.signature), digest, { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
    const recovered = toHex(keccak(uncompressed.slice(1)).slice(12));
    return recovered === owner ? { ok: true } : { ok: false, reason: "signature was made by a different key" };
  } catch (e) {
    return { ok: false, reason: `malformed seal (${(e as Error).message})` };
  }
}
