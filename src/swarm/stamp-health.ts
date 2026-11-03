/**
 * Postage-stamp health. Swarm only keeps data while its stamp is alive, so a newsroom must SEE
 * how much time and space is left before it becomes a problem. Pure functions, unit-tested.
 *
 * Raw shape is Bee's `GET /stamps/{id}` response. Fields we rely on:
 *   usable, batchTTL (seconds left), utilization (fullest bucket), depth, bucketDepth, immutableFlag
 * Note on capacity: a batch counts as FULL as soon as its single fullest bucket is full, not when
 * the nominal size is reached, so `utilization / 2^(depth-bucketDepth)` is the number that matters.
 */

export interface RawStamp {
  batchID?: string;
  usable?: boolean;
  exists?: boolean;
  expired?: boolean;
  batchTTL?: number;
  utilization?: number;
  utilizationRatio?: number;
  depth?: number;
  bucketDepth?: number;
  immutableFlag?: boolean;
  label?: string;
}

export type Level = "ok" | "warn" | "critical";

export interface StampHealth {
  level: Level;
  /** Fraction (0..1) of the fullest bucket in use. */
  usage: number;
  /** Seconds until the network may drop the data (an estimate: price can change). */
  ttlSeconds: number;
  immutable: boolean;
  usable: boolean;
  /** Human-readable findings, most urgent first. */
  messages: string[];
}

export const DAY = 86_400;
export const WARN_TTL = 14 * DAY;
export const CRITICAL_TTL = 3 * DAY;
export const WARN_USAGE = 0.7;
export const CRITICAL_USAGE = 0.9;

export function assessStamp(raw: RawStamp): StampHealth {
  const messages: string[] = [];
  let level: Level = "ok";
  const bump = (l: Level) => {
    if (l === "critical" || (l === "warn" && level === "ok")) level = l;
  };

  const ttl = Number.isFinite(raw.batchTTL) ? Math.max(0, raw.batchTTL as number) : 0;
  const depth = raw.depth ?? 0;
  const bucketDepth = raw.bucketDepth ?? 16;
  const capacity = depth > bucketDepth ? 2 ** (depth - bucketDepth) : 1;
  const usage =
    typeof raw.utilizationRatio === "number"
      ? raw.utilizationRatio
      : Math.min(1, (raw.utilization ?? 0) / capacity);
  const immutable = raw.immutableFlag === true;
  const usable = raw.usable !== false && raw.exists !== false && raw.expired !== true;

  if (raw.expired === true || raw.exists === false) {
    bump("critical");
    messages.push("This postage batch has expired or does not exist: the network may already be dropping your stories. Buy a new batch and republish.");
  } else if (raw.usable === false) {
    bump("warn");
    messages.push("This batch is not usable yet. A newly bought batch needs a minute or two to confirm on-chain.");
  }

  if (!immutable) {
    bump("critical");
    messages.push(
      "This batch is MUTABLE. When it fills up, Swarm overwrites the oldest chunks, which can break the feed and with it your permanent link. Use an immutable batch.",
    );
  }

  if (usage >= CRITICAL_USAGE) {
    bump("critical");
    messages.push(`Storage is ${Math.round(usage * 100)}% full. The next publish may be refused. Dilute the batch or buy a bigger one.`);
  } else if (usage >= WARN_USAGE) {
    bump("warn");
    messages.push(`Storage is ${Math.round(usage * 100)}% full. Plan to dilute the batch soon.`);
  }

  if (usable && ttl <= CRITICAL_TTL) {
    bump("critical");
    messages.push(`Only ${formatDuration(ttl)} of storage left. Top up now or the site can disappear.`);
  } else if (usable && ttl <= WARN_TTL) {
    bump("warn");
    messages.push(`About ${formatDuration(ttl)} of storage left. Top up soon.`);
  }

  return { level, usage, ttlSeconds: ttl, immutable, usable, messages };
}

export function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 2 * DAY) return `${Math.round(seconds / 3600)} h`;
  if (seconds < 90 * DAY) return `${Math.round(seconds / DAY)} days`;
  return `${(seconds / (30 * DAY)).toFixed(1)} months`;
}
