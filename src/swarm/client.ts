import { Bee, PrivateKey, Topic } from "@ethersphere/bee-js";
import { fromUtf8, strip0x } from "../shared/bytes";
import { PATHS, type PostsIndex, type SnapshotFile } from "../shared/types";
import { explainError } from "./errors";
import { withRetry } from "./retry";
import { assessStamp, type RawStamp, type StampHealth } from "./stamp-health";

export interface SwarmConfig {
  /** Bee API (your node, or a gateway that accepts uploads). No trailing slash needed. */
  beeUrl: string;
  /** 64-hex postage batch id. */
  batchId: string;
}

export interface PublishProgress {
  step: "upload" | "feed" | "confirm";
  message: string;
}

export interface PublishResult {
  snapshotRef: string;
  feedIndex: string;
  /** Did the permanent link serve the new version when we read it back? */
  confirmed: boolean;
  confirmNote: string;
}

const norm = (u: string) => u.trim().replace(/\/+$/, "");

export class SwarmClient {
  readonly beeUrl: string;
  private _bee: Bee | undefined;

  constructor(
    readonly cfg: SwarmConfig,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    this.beeUrl = norm(cfg.beeUrl);
  }

  /** Created lazily: bee-js rejects malformed addresses in its constructor, and a typo in Settings must surface as a normal error message, not a crash. */
  get bee(): Bee {
    // Uploads of a few MB over a slow link must not time out after the default 30 s.
    return (this._bee ??= new Bee(this.beeUrl, { timeout: 5 * 60_000 }));
  }

  /** Is there a Bee API at this address? Uses plain fetch so it also works against gateways. */
  async health(): Promise<{ ok: boolean; note: string }> {
    try {
      const r = await this.fetchImpl(`${this.beeUrl}/health`, { cache: "no-store" });
      if (!r.ok) return { ok: false, note: `Node answered HTTP ${r.status}` };
      const j = (await r.json().catch(() => ({}))) as { status?: string; version?: string };
      return { ok: j.status === undefined || j.status === "ok", note: j.version ? `Bee ${j.version}` : "reachable" };
    } catch (e) {
      return { ok: false, note: explainError(e).title };
    }
  }

  async stamp(): Promise<StampHealth> {
    const r = await this.fetchImpl(`${this.beeUrl}/stamps/${strip0x(this.cfg.batchId)}`, { cache: "no-store" });
    if (r.status === 404) {
      return assessStamp({ exists: false, immutableFlag: true });
    }
    if (!r.ok) throw Object.assign(new Error(`stamp lookup failed (HTTP ${r.status})`), { status: r.status });
    return assessStamp((await r.json()) as RawStamp);
  }

  /** Upload all files as one collection. Returns the snapshot's root reference. */
  async uploadSnapshot(files: SnapshotFile[], onRetry?: (n: number) => void): Promise<string> {
    const entries = files.map((f) => ({
      path: f.path,
      size: f.bytes.length,
      file: new File([f.bytes as BlobPart], f.path.split("/").pop() ?? "file"),
    }));
    const res = await withRetry(
      () => this.bee.collection.upload(this.cfg.batchId, entries, { indexDocument: PATHS.index }),
      { onRetry: (n) => onRetry?.(n) },
    );
    return res.reference.toHex();
  }

  /** Create (idempotent) the feed manifest: the permanent link. Needs only owner + topic. */
  async ensureManifest(privateKeyHex: string, topic: string): Promise<string> {
    const owner = new PrivateKey(privateKeyHex).publicKey().address();
    const ref = await withRetry(() => this.bee.feed.createManifest(this.cfg.batchId, Topic.fromString(topic), owner));
    return ref.toHex();
  }

  /** Point the feed at a new snapshot. Each call writes the next index. */
  async pointFeedAt(privateKeyHex: string, topic: string, snapshotRef: string, onRetry?: (n: number) => void): Promise<string> {
    const writer = this.bee.feed.makeWriter(Topic.fromString(topic), new PrivateKey(privateKeyHex));
    await withRetry(() => writer.uploadReference(this.cfg.batchId, snapshotRef), { onRetry: (n) => onRetry?.(n) });
    // Read back the index we just wrote (next index - 1).
    const latest = await this.latestFeed(new PrivateKey(privateKeyHex).publicKey().address().toHex(), topic);
    return latest ? latest.index : "0";
  }

  /** Latest feed entry straight from the feed (not through the manifest URL). */
  async latestFeed(ownerHex: string, topic: string): Promise<{ reference: string; index: string } | null> {
    try {
      const reader = this.bee.feed.makeReader(Topic.fromString(topic), strip0x(ownerHex));
      const res = await reader.downloadReference();
      return { reference: res.reference.toHex(), index: res.feedIndex.toBigInt().toString() };
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 400 || /not found|no update|404/i.test(String((e as Error).message))) return null;
      throw e;
    }
  }

  /** GET a file from a snapshot (or manifest) through this node. Cache-busting is not possible on content-addressed URLs, so we ask for no-store. */
  async fetchFile(root: string, path: string): Promise<Uint8Array> {
    const r = await this.fetchImpl(`${this.beeUrl}/bzz/${root}/${path}`, { cache: "no-store" });
    if (!r.ok) throw Object.assign(new Error(`GET ${path} failed (HTTP ${r.status})`), { status: r.status });
    return new Uint8Array(await r.arrayBuffer());
  }

  async fetchPosts(root: string): Promise<PostsIndex> {
    return JSON.parse(fromUtf8(await this.fetchFile(root, PATHS.posts))) as PostsIndex;
  }

  /**
   * After publishing, read the permanent link back and check it serves the new version.
   * Feed lookups can lag a few seconds on a busy network, so poll.
   */
  async confirm(manifest: string, expectedVersion: number, timeoutMs = 45_000, pollMs = 2_500): Promise<{ confirmed: boolean; note: string }> {
    const deadline = Date.now() + timeoutMs;
    let lastNote = "link not readable yet";
    while (Date.now() < deadline) {
      try {
        const idx = await this.fetchPosts(manifest);
        if (idx.version >= expectedVersion) return { confirmed: true, note: `link serves version ${idx.version}` };
        lastNote = `link still serves version ${idx.version}`;
      } catch (e) {
        lastNote = explainError(e).title;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { confirmed: false, note: lastNote };
  }

  /** The whole publish: upload snapshot, move the feed, verify the link. */
  async publish(
    files: SnapshotFile[],
    feed: { privateKeyHex: string; topic: string; manifest: string },
    expectedVersion: number,
    onProgress?: (p: PublishProgress) => void,
  ): Promise<PublishResult> {
    onProgress?.({ step: "upload", message: `Uploading ${files.length} files to Swarm…` });
    const snapshotRef = await this.uploadSnapshot(files, (n) =>
      onProgress?.({ step: "upload", message: `Network hiccup, retrying upload (${n})…` }),
    );
    onProgress?.({ step: "feed", message: "Moving your permanent link to the new version…" });
    const feedIndex = await this.pointFeedAt(feed.privateKeyHex, feed.topic, snapshotRef, (n) =>
      onProgress?.({ step: "feed", message: `Network hiccup, retrying link update (${n})…` }),
    );
    onProgress?.({ step: "confirm", message: "Checking that the link now shows your update…" });
    const c = await this.confirm(feed.manifest, expectedVersion);
    return { snapshotRef, feedIndex, confirmed: c.confirmed, confirmNote: c.note };
  }
}
