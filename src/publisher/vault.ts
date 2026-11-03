/**
 * The publisher key is the ONLY thing that can move the permanent link. Lose it and the newsroom
 * can never update that link again; leak it and anyone can publish as the newsroom. So:
 *  - it is generated in the browser and never sent anywhere,
 *  - at rest it is encrypted with a passphrase (PBKDF2-SHA256 -> AES-256-GCM),
 *  - it can be exported as a keystore file for backup and imported on another device.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { fromHex, strip0x, toHex } from "../shared/bytes";
import { addressOf } from "../shared/seal";

export interface Keystore {
  v: 1;
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  /** Public: lets the UI show which newsroom a keystore belongs to without unlocking it. */
  address: string;
}

export const DEFAULT_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 10;

export function generateKey(): string {
  // randomPrivateKey retries until the value is a valid curve scalar.
  return toHex(secp256k1.utils.randomSecretKey());
}

export function normalizeKey(input: string): string {
  const hex = strip0x(input.trim()).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("A private key is 64 hexadecimal characters.");
  if (!secp256k1.utils.isValidSecretKey(fromHex(hex))) throw new Error("That is not a valid private key.");
  return hex;
}

export function checkPassphrase(p: string): string | null {
  if (p.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters. A few random words make a strong passphrase.`;
  return null;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function createKeystore(privateKeyHex: string, passphrase: string, iterations = DEFAULT_ITERATIONS): Promise<Keystore> {
  const key = normalizeKey(privateKeyHex);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await deriveKey(passphrase, salt, iterations);
  const address = addressOf(key);
  // Bind the address as associated data so a keystore cannot be relabelled.
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: new TextEncoder().encode(address) as BufferSource }, aes, fromHex(key) as BufferSource),
  );
  return { v: 1, kdf: "pbkdf2-sha256", iterations, salt: toHex(salt), iv: toHex(iv), ciphertext: toHex(ct), address };
}

/** Throws a friendly error on a wrong passphrase or damaged file. */
export async function openKeystore(ks: Keystore, passphrase: string): Promise<string> {
  if (ks.v !== 1 || ks.kdf !== "pbkdf2-sha256") throw new Error("Unsupported keystore format.");
  if (!(ks.iterations >= 1000 && ks.iterations <= 5_000_000)) throw new Error("Damaged keystore (bad iteration count).");
  try {
    const aes = await deriveKey(passphrase, fromHex(ks.salt), ks.iterations);
    const pt = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(ks.iv) as BufferSource, additionalData: new TextEncoder().encode(ks.address) as BufferSource }, aes, fromHex(ks.ciphertext) as BufferSource),
    );
    const key = toHex(pt);
    if (addressOf(key) !== ks.address) throw new Error("address mismatch");
    return key;
  } catch {
    throw new Error("Wrong passphrase, or the keystore file is damaged.");
  }
}

export function parseKeystore(text: string): Keystore {
  let j: Partial<Keystore>;
  try {
    j = JSON.parse(text) as Partial<Keystore>;
  } catch {
    throw new Error("That file is not a Parcha keystore.");
  }
  if (j.v !== 1 || !j.salt || !j.iv || !j.ciphertext || !j.address || typeof j.iterations !== "number") {
    throw new Error("That file is not a Parcha keystore.");
  }
  return j as Keystore;
}
