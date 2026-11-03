import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes as nobleHexToBytes } from "@noble/hashes/utils.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);
export const toHex = (b: Uint8Array): string => bytesToHex(b);

export function strip0x(h: string): string {
  return h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
}

export function fromHex(h: string): Uint8Array {
  return nobleHexToBytes(strip0x(h));
}

export const sha256Hex = (b: Uint8Array): string => toHex(sha256(b));
export const keccak = (b: Uint8Array): Uint8Array => keccak_256(b);

export const jsonBytes = (v: unknown): Uint8Array => utf8(JSON.stringify(v, null, 2));
