/**
 * A tiny in-memory imitation of the parts of a Bee node that Parcha uses, so the whole publish
 * flow can be developed and tested offline (and in CI) without xBZZ:
 *
 *   GET  /health
 *   GET  /stamps/:id                      (configurable, for testing stamp warnings)
 *   POST /bzz        (tar collection)     -> { reference }
 *   GET  /bzz/:ref/*path                  (collection files, and feed manifests -> latest snapshot)
 *   POST /soc/:owner/:id?sig=             (single owner chunks, used by feeds)
 *   GET  /chunks/:addr
 *   GET  /feeds/:owner/:topic             (latest index + headers)
 *   POST /feeds/:owner/:topic             (create feed manifest)
 *
 * It is NOT Swarm: no network, no stamps accounting, no signature checks. Never use it as proof of
 * anything except "our code speaks the protocol correctly". The real proof is scripts/verify-link.ts
 * against real gateways.
 *
 * Knobs (env or startMockBee options): MOCK_LAG_MS delays when a new feed entry becomes visible,
 * MOCK_FLAKY (0..1) makes uploads fail with 503 at random, to exercise the retry logic.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { sha256Hex, fromHex, keccak, toHex } from "../src/shared/bytes";

export interface MockOptions {
  port?: number;
  batchId?: string;
  lagMs?: number;
  flaky?: number;
  stamp?: Record<string, unknown>;
}

interface Collection {
  files: Map<string, Uint8Array>;
  indexDocument: string;
}

export interface MockBee {
  url: string;
  batchId: string;
  server: Server;
  /** Tweak the reported stamp, e.g. { batchTTL: 3600, immutableFlag: false }. */
  setStamp(patch: Record<string, unknown>): void;
  setFlaky(p: number): void;
  /** Make the next n upload requests (bzz or soc) fail with 503, deterministically. */
  failNext(n: number): void;
  setLag(ms: number): void;
  stats(): { collections: number; feedWrites: number; uploads: number };
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export async function startMockBee(opts: MockOptions = {}): Promise<MockBee> {
  const batchId = opts.batchId ?? "ab".repeat(32);
  let flaky = opts.flaky ?? 0;
  let failures = 0;
  const shouldFail = () => (failures > 0 ? (failures--, true) : flaky > 0 && Math.random() < flaky);
  let lagMs = opts.lagMs ?? 0;
  let stampOverrides: Record<string, unknown> = { ...opts.stamp };

  const collections = new Map<string, Collection>();
  const socs = new Map<string, { data: Uint8Array; visibleAt: number }>(); // address hex -> full SOC bytes
  const manifests = new Map<string, { owner: string; topic: string }>(); // manifest ref -> feed
  let uploads = 0;
  let feedWrites = 0;

  const cors = (res: ServerResponse) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("access-control-expose-headers", "swarm-feed-index,swarm-feed-index-next,swarm-tag,content-type");
  };

  const readBody = (req: IncomingMessage): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => resolve(new Uint8Array(Buffer.concat(parts))));
      req.on("error", reject);
    });

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const indexBytes = (i: bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, i, false);
    return b;
  };
  const concat = (...arrs: Uint8Array[]) => {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrs) (out.set(a, o), (o += a.length));
    return out;
  };
  const socAddress = (id: Uint8Array, owner: Uint8Array) => toHex(keccak(concat(id, owner)));
  const feedIdentifier = (topic: Uint8Array, i: bigint) => keccak(concat(topic, indexBytes(i)));

  /** Highest consecutive visible index for a feed, or -1. */
  function latestIndex(ownerHex: string, topicHex: string): bigint {
    const owner = fromHex(ownerHex);
    const topic = fromHex(topicHex);
    let i = 0n;
    const now = Date.now();
    for (;;) {
      const entry = socs.get(socAddress(feedIdentifier(topic, i), owner));
      if (!entry || entry.visibleAt > now) return i - 1n;
      i++;
    }
  }

  function feedPayload(ownerHex: string, topicHex: string, index: bigint): Uint8Array | null {
    const entry = socs.get(socAddress(feedIdentifier(fromHex(topicHex), index), fromHex(ownerHex)));
    if (!entry) return null;
    // SOC bytes: id(32) sig(65) span(8) payload
    return entry.data.slice(32 + 65 + 8);
  }

  function parseTar(buf: Uint8Array): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    let off = 0;
    const text = (a: number, b: number) => new TextDecoder().decode(buf.slice(off + a, off + b)).replace(/\0.*$/s, "");
    while (off + 512 <= buf.length) {
      const name = text(0, 100);
      if (!name) break;
      const prefix = text(345, 500);
      const size = parseInt(text(124, 136).trim() || "0", 8);
      const type = text(156, 157);
      off += 512;
      if (type === "0" || type === "" || type === "\0") {
        files.set(prefix ? `${prefix}/${name}` : name, buf.slice(off, off + size));
      }
      off += Math.ceil(size / 512) * 512; // skip data blocks: `off` is now the next header
    }
    return files;
  }

  function serveFile(res: ServerResponse, col: Collection, path: string, extra: Record<string, string> = {}) {
    let p = path.replace(/^\/+/, "");
    if (p === "" || p.endsWith("/")) p += col.indexDocument;
    const data = col.files.get(p);
    if (!data) return json(res, 404, { code: 404, message: "path address not found" });
    const ext = p.split(".").pop() ?? "";
    res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store", ...extra });
    res.end(Buffer.from(data));
  }

  const server = createServer(async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    const url = new URL(req.url ?? "/", "http://mock");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (url.pathname === "/health") return json(res, 200, { status: "ok", version: "mock-0.0.0", apiVersion: "mock" });

      if (parts[0] === "stamps" && parts[1] === batchId && req.method === "GET") {
        return json(res, 200, {
          batchID: batchId,
          utilization: 1,
          usable: true,
          label: "mock",
          depth: 20,
          amount: "1000000000",
          bucketDepth: 16,
          blockNumber: 1,
          immutableFlag: true,
          batchTTL: 90 * 86_400,
          exists: true,
          ...stampOverrides,
        });
      }
      if (parts[0] === "stamps" && req.method === "GET") return json(res, 404, { code: 404, message: "batch not found" });

      if (parts[0] === "bzz" && req.method === "POST") {
        if (shouldFail()) return json(res, 503, { code: 503, message: "mock: temporarily unavailable" });
        if (req.headers["swarm-postage-batch-id"] !== batchId) return json(res, 400, { code: 400, message: "invalid postage batch id" });
        const body = await readBody(req);
        const files = parseTar(body);
        if (files.size === 0) return json(res, 400, { code: 400, message: "empty collection" });
        const ref = sha256Hex(body);
        collections.set(ref, { files, indexDocument: String(req.headers["swarm-index-document"] ?? "index.html") });
        uploads++;
        return json(res, 201, { reference: ref });
      }

      if (parts[0] === "bzz" && req.method === "GET" && parts[1]) {
        const ref = parts[1];
        const rest = parts.slice(2).join("/") + (url.pathname.endsWith("/") ? "/" : "");
        const mf = manifests.get(ref);
        if (mf) {
          const idx = latestIndex(mf.owner, mf.topic);
          if (idx < 0n) return json(res, 404, { code: 404, message: "feed not found" });
          const payload = feedPayload(mf.owner, mf.topic, idx)!;
          const target = toHex(payload.slice(8, 40));
          const col = collections.get(target);
          if (!col) return json(res, 404, { code: 404, message: "referenced content not found" });
          return serveFile(res, col, rest, { "swarm-feed-index": toHex(indexBytes(idx)) });
        }
        const col = collections.get(ref);
        if (!col) return json(res, 404, { code: 404, message: "not found" });
        if (parts.length === 2 && !url.pathname.endsWith("/")) {
          res.writeHead(301, { location: `${url.pathname}/` });
          return void res.end();
        }
        return serveFile(res, col, rest);
      }

      if (parts[0] === "soc" && req.method === "POST") {
        if (shouldFail()) return json(res, 503, { code: 503, message: "mock: temporarily unavailable" });
        const [, owner, id] = parts;
        const sig = url.searchParams.get("sig");
        if (!owner || !id || !sig) return json(res, 400, { code: 400, message: "bad soc request" });
        const body = await readBody(req);
        const full = concat(fromHex(id), fromHex(sig), body);
        const addr = socAddress(fromHex(id), fromHex(owner));
        if (socs.has(addr)) return json(res, 409, { code: 409, message: "chunk already exists" });
        socs.set(addr, { data: full, visibleAt: Date.now() + lagMs });
        feedWrites++;
        return json(res, 201, { reference: addr });
      }

      if (parts[0] === "chunks" && req.method === "GET" && parts[1]) {
        const e = socs.get(parts[1]);
        if (!e) return json(res, 404, { code: 404, message: "chunk not found" });
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return void res.end(Buffer.from(e.data));
      }

      if (parts[0] === "feeds" && parts.length === 3) {
        const [, owner, topic] = parts as [string, string, string];
        if (req.method === "POST") {
          const ref = sha256Hex(new TextEncoder().encode(`feed:${owner}:${topic}`));
          manifests.set(ref, { owner, topic });
          return json(res, 201, { reference: ref });
        }
        if (req.method === "GET") {
          const idx = latestIndex(owner, topic);
          if (idx < 0n) return json(res, 404, { code: 404, message: "feed not found" });
          const payload = feedPayload(owner, topic, idx)!;
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "swarm-feed-index": toHex(indexBytes(idx)),
            "swarm-feed-index-next": toHex(indexBytes(idx + 1n)),
          });
          return void res.end(Buffer.from(payload));
        }
      }

      return json(res, 404, { code: 404, message: `mock: no route for ${req.method} ${url.pathname}` });
    } catch (e) {
      return json(res, 500, { code: 500, message: (e as Error).message });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port!;

  return {
    url: `http://127.0.0.1:${port}`,
    batchId,
    server,
    setStamp: (patch) => void (stampOverrides = { ...stampOverrides, ...patch }),
    setFlaky: (p) => void (flaky = p),
    failNext: (n) => void (failures = n),
    setLag: (ms) => void (lagMs = ms),
    stats: () => ({ collections: collections.size, feedWrites, uploads }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// CLI: `npm run mock-bee`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockBee({
    port: Number(process.env.PORT ?? 1633),
    lagMs: Number(process.env.MOCK_LAG_MS ?? 0),
    flaky: Number(process.env.MOCK_FLAKY ?? 0),
  });
  console.log(`mock Bee listening on ${mock.url}`);
  console.log(`batch id: ${mock.batchId}`);
}
