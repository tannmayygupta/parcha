/**
 * Turns low-level Bee / network failures into messages a journalist can act on.
 * The raw error is always kept in `detail` for the log.
 */
export interface FriendlyError {
  title: string;
  advice: string;
  detail: string;
  /** Worth retrying automatically? */
  transient: boolean;
}

interface Maybe {
  status?: number;
  message?: string;
  responseBody?: unknown;
  response?: { status?: number; data?: unknown };
  code?: string;
  name?: string;
}

export function explainError(err: unknown): FriendlyError {
  const e = (err ?? {}) as Maybe;
  const status = e.status ?? e.response?.status;
  const body = safeStr(e.responseBody ?? e.response?.data);
  const msg = `${e.message ?? String(err)} ${body}`.toLowerCase();
  const detail = [status ? `HTTP ${status}` : "", e.message ?? "", body].filter(Boolean).join(" · ");

  if (/bucket.*full|batch.*full|stamp.*full|batch is full|overissued|stamp.*exhaust/.test(msg)) {
    return {
      title: "The storage batch is full",
      advice: "Dilute the batch (bigger depth) or buy a new immutable batch, then publish again. Nothing was published.",
      detail,
      transient: false,
    };
  }
  if (status === 402 || /payment required|insufficient funds|not usable|batch not usable/.test(msg)) {
    return {
      title: "The storage batch cannot be used",
      advice: "It may be brand new (wait a minute), expired, or the node wallet is out of funds.",
      detail,
      transient: false,
    };
  }
  if (/(batch|stamp).*(not found|does not exist|invalid)|invalid batch|batch.*expired/.test(msg) || (status === 404 && /stamp|batch/.test(msg))) {
    return {
      title: "Storage batch not found",
      advice: "Check the batch ID in Settings. It may belong to a different node, or it has expired.",
      detail,
      transient: false,
    };
  }
  if (status === 401 || status === 403) {
    return {
      title: "The Swarm endpoint refused the request",
      advice: "This gateway needs authentication or does not allow uploads. Use your own Bee node or an upload-enabled gateway.",
      detail,
      transient: false,
    };
  }
  if (status === 413) {
    return { title: "Upload too large", advice: "Remove or shrink images and try again.", detail, transient: false };
  }
  if (status && status >= 500) {
    return {
      title: "The Swarm node had a problem",
      advice: "This is usually temporary. We retry automatically; if it keeps failing, try again in a few minutes.",
      detail,
      transient: true,
    };
  }
  if (status === 429 || status === 408 || status === 425) {
    return { title: "The node is busy", advice: "Retrying with a short delay.", detail, transient: true };
  }
  if (/failed to fetch|network|econnrefused|enotfound|fetch failed|load failed|timeout|timed out|aborted|cors/.test(msg)) {
    return {
      title: "Cannot reach the Swarm node",
      advice:
        "Check your internet connection and the node address in Settings. If you run your own Bee node, make sure it is started and allows requests from this page (CORS).",
      detail,
      transient: true,
    };
  }
  return { title: "Something went wrong", advice: "Nothing was lost: your draft is saved on this device. See details below.", detail, transient: false };
}

function safeStr(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.slice(0, 300);
  try {
    return JSON.stringify(v).slice(0, 300);
  } catch {
    return "";
  }
}
