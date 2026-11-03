import { explainError } from "./errors";

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  /** Called before each wait, so the UI can say "retrying (2/4)…". */
  onRetry?: (attempt: number, error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retries transient failures (network, 5xx, 429) with exponential backoff; fails fast on the rest. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseMs ?? 800;
  const sleep = opts.sleep ?? realSleep;
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === attempts || !explainError(e).transient) break;
      opts.onRetry?.(i, e);
      await sleep(base * 2 ** (i - 1));
    }
  }
  throw last;
}
