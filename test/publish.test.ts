import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrivateKey } from "@ethersphere/bee-js";
import { startMockBee, type MockBee } from "../scripts/mock-bee";
import { SwarmClient } from "../src/swarm/client";
import { buildSnapshot } from "../src/shared/snapshot";
import { addressOf, verifySeal } from "../src/shared/seal";
import { fromUtf8, toHex, utf8 } from "../src/shared/bytes";
import { PATHS, type Post, type PostsIndex, type Seal, type SiteMeta } from "../src/shared/types";

const reader = [{ path: "index.html", content: "<!doctype html><title>reader</title>" }];
const KEY = toHex(crypto.getRandomValues(new Uint8Array(32)));
const TOPIC = "test-newsroom";

function post(id: string, title: string, at: string): Post {
  return { id, title, summary: title, kind: "article", publishedAt: at, updatedAt: at, tags: [], markdown: `# ${title}\n\nBody` };
}

describe("publish flow against a mock Bee", () => {
  let mock: MockBee;
  let client: SwarmClient;
  let site: SiteMeta;

  beforeAll(async () => {
    mock = await startMockBee();
    client = new SwarmClient({ beeUrl: mock.url, batchId: mock.batchId });
    const manifest = await client.ensureManifest(KEY, TOPIC);
    site = {
      schema: 1,
      title: "Test Newsroom",
      tagline: "t",
      about: "",
      lang: "en",
      feed: { owner: addressOf(KEY), topic: TOPIC, manifest },
      createdAt: new Date().toISOString(),
    };
  });
  afterAll(() => mock.close());

  it("derives the same owner address as bee-js", () => {
    expect(addressOf(KEY)).toBe(new PrivateKey(KEY).publicKey().address().toHex());
  });

  it("health + stamp info", async () => {
    expect((await client.health()).ok).toBe(true);
    const s = await client.stamp();
    expect(s.immutable).toBe(true);
    expect(s.level).toBe("ok");
  });

  it("one link keeps showing the latest version after each publish", async () => {
    const a = buildSnapshot({ site, posts: [post("aaaaaa1", "First", "2026-11-04T10:00:00Z")], media: new Map(), reader, previousVersion: 0, privateKeyHex: KEY });
    const r1 = await client.publish(a.files, { privateKeyHex: KEY, topic: TOPIC, manifest: site.feed.manifest }, a.version);
    expect(r1.confirmed).toBe(true);
    let idx = await client.fetchPosts(site.feed.manifest);
    expect(idx.version).toBe(1);
    expect(idx.posts.map((p) => p.title)).toEqual(["First"]);

    const b = buildSnapshot({
      site,
      posts: [post("aaaaaa1", "First", "2026-11-04T10:00:00Z"), post("bbbbbb2", "Second", "2026-11-04T11:00:00Z")],
      media: new Map(),
      reader,
      previousVersion: 1,
      privateKeyHex: KEY,
    });
    const r2 = await client.publish(b.files, { privateKeyHex: KEY, topic: TOPIC, manifest: site.feed.manifest }, b.version);
    expect(r2.confirmed).toBe(true);
    expect(r2.snapshotRef).not.toBe(r1.snapshotRef);
    idx = await client.fetchPosts(site.feed.manifest);
    expect(idx.version).toBe(2);
    expect(idx.posts.map((p) => p.title)).toEqual(["Second", "First"]); // newest first

    // the feed itself agrees
    const latest = await client.latestFeed(site.feed.owner, TOPIC);
    expect(latest?.reference).toBe(r2.snapshotRef);
  });

  it("served data carries a valid seal and matching post hashes", async () => {
    const postsBytes = await client.fetchFile(site.feed.manifest, PATHS.posts);
    const seal = JSON.parse(fromUtf8(await client.fetchFile(site.feed.manifest, PATHS.seal))) as Seal;
    expect(verifySeal(seal, postsBytes, site.feed.owner)).toEqual({ ok: true });
    const idx = JSON.parse(fromUtf8(postsBytes)) as PostsIndex;
    for (const meta of idx.posts) {
      const bytes = await client.fetchFile(site.feed.manifest, PATHS.post(meta.id));
      const { sha256Hex } = await import("../src/shared/bytes");
      expect(sha256Hex(bytes)).toBe(meta.hash);
    }
  });

  it("a tampered posts.json fails seal verification", async () => {
    const postsBytes = await client.fetchFile(site.feed.manifest, PATHS.posts);
    const seal = JSON.parse(fromUtf8(await client.fetchFile(site.feed.manifest, PATHS.seal))) as Seal;
    const tampered = utf8(fromUtf8(postsBytes).replace("Second", "Sacond"));
    const res = verifySeal(seal, tampered, site.feed.owner);
    expect(res.ok).toBe(false);
  });

  it("a seal signed by someone else is rejected", async () => {
    const other = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const postsBytes = await client.fetchFile(site.feed.manifest, PATHS.posts);
    const forged = buildSnapshot({ site, posts: [post("cccccc3", "Fake", "2026-11-04T12:00:00Z")], media: new Map(), reader, previousVersion: 1, privateKeyHex: other });
    const forgedSeal = JSON.parse(fromUtf8(forged.files.find((f) => f.path === PATHS.seal)!.bytes)) as Seal;
    // claims the real owner but the signature is from `other`
    forgedSeal.owner = site.feed.owner;
    expect(verifySeal(forgedSeal, postsBytes, site.feed.owner).ok).toBe(false);
  });

  it("survives a flaky network via retries", async () => {
    mock.failNext(2); // first two upload requests fail, the third succeeds
    const snap = buildSnapshot({ site, posts: [post("dddddd4", "Flaky", "2026-11-04T13:00:00Z")], media: new Map(), reader, previousVersion: 2, privateKeyHex: KEY });
    const res = await client.publish(snap.files, { privateKeyHex: KEY, topic: TOPIC, manifest: site.feed.manifest }, snap.version);
    expect(res.confirmed).toBe(true);
  }, 60_000);

  it("confirm() waits for a lagging feed instead of failing", async () => {
    mock.setLag(1500);
    const snap = buildSnapshot({ site, posts: [post("eeeeee5", "Lagged", "2026-11-04T14:00:00Z")], media: new Map(), reader, previousVersion: 3, privateKeyHex: KEY });
    const res = await client.publish(snap.files, { privateKeyHex: KEY, topic: TOPIC, manifest: site.feed.manifest }, snap.version);
    mock.setLag(0);
    expect(res.confirmed).toBe(true);
  }, 60_000);

  it("reports stamp problems", async () => {
    mock.setStamp({ immutableFlag: false, batchTTL: 3600, utilization: 60000 });
    const s = await client.stamp();
    expect(s.level).toBe("critical");
    expect(s.messages.join(" ")).toMatch(/MUTABLE/);
    mock.setStamp({ immutableFlag: true, batchTTL: 90 * 86400, utilization: 1 });
  });

  it("explains an unknown batch", async () => {
    const bad = new SwarmClient({ beeUrl: mock.url, batchId: "cd".repeat(32) });
    const s = await bad.stamp();
    expect(s.level).toBe("critical");
    await expect(bad.uploadSnapshot([{ path: "index.html", bytes: utf8("x") }])).rejects.toBeTruthy();
  });
});
