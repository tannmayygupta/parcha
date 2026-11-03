/**
 * Local persistence for the publisher (this device only; the REAL record is on Swarm).
 *  - localStorage: settings, encrypted keystore, newsroom state (text only, small)
 *  - IndexedDB: image bytes
 * Every access is wrapped: private windows and blocked storage must degrade, not crash.
 */
import type { Saved } from "./newsroom";
import type { Keystore } from "./vault";

const K = {
  settings: "parcha.settings",
  keystore: "parcha.keystore",
  saved: "parcha.newsroom",
  backupAck: "parcha.backupAck",
} as const;

export interface Settings {
  beeUrl: string;
  batchId: string;
}

export const DEFAULT_SETTINGS: Settings = { beeUrl: "http://localhost:1633", batchId: "" };

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const storageAvailable = (): boolean => {
  try {
    localStorage.setItem("parcha.probe", "1");
    localStorage.removeItem("parcha.probe");
    return true;
  } catch {
    return false;
  }
};

export const loadSettings = (): Settings => ({ ...DEFAULT_SETTINGS, ...(read<Settings>(K.settings) ?? {}) });
export const saveSettings = (s: Settings): boolean => write(K.settings, s);

export const loadKeystore = (): Keystore | null => read<Keystore>(K.keystore);
export const saveKeystore = (k: Keystore): boolean => write(K.keystore, k);

export const loadSaved = (): Saved | null => read<Saved>(K.saved);
export const saveSaved = (s: Saved): boolean => write(K.saved, s);

export const backupAcknowledged = (): boolean => read<boolean>(K.backupAck) === true;
export const setBackupAcknowledged = (): boolean => write(K.backupAck, true);

export function wipeLocal(): void {
  try {
    for (const k of Object.values(K)) localStorage.removeItem(k);
    indexedDB.deleteDatabase("parcha-media");
  } catch {
    /* nothing more we can do */
  }
}

// ---- media (IndexedDB) -------------------------------------------------------------------------

const DB = "parcha-media";
const STORE = "media";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => (db.close(), resolve(req.result));
    t.onerror = () => (db.close(), reject(t.error));
    t.onabort = () => (db.close(), reject(t.error));
  });
}

const memoryFallback = new Map<string, Uint8Array>();

export async function putMedia(path: string, bytes: Uint8Array): Promise<void> {
  memoryFallback.set(path, bytes);
  try {
    await tx("readwrite", (s) => s.put(bytes, path));
  } catch {
    /* kept in memory for this session only */
  }
}

export async function getMedia(path: string): Promise<Uint8Array | undefined> {
  try {
    const v = await tx<Uint8Array | undefined>("readonly", (s) => s.get(path) as IDBRequest<Uint8Array | undefined>);
    if (v) return new Uint8Array(v);
  } catch {
    /* fall through */
  }
  return memoryFallback.get(path);
}
