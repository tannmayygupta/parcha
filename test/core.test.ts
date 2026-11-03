// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { refToCid, isSwarmRef } from "../src/shared/cid";
import { GATEWAYS } from "../src/shared/gateways";
import { renderMarkdown } from "../src/shared/render";
import { assessStamp, DAY } from "../src/swarm/stamp-health";
import { explainError } from "../src/swarm/errors";
import { withRetry } from "../src/swarm/retry";
import { assertSafePaths, buildSnapshot } from "../src/shared/snapshot";
import { isSafeId, newPostId, summarise } from "../src/shared/ids";
import { toHex } from "../src/shared/bytes";

describe("CID for bzz.link", () => {
  it("encodes a Swarm reference to a <=63 char base32 CID with the swarm-manifest prefix", () => {
    const cid = refToCid("3bde66cca4bcbc3c49f21b55446dc437fb2d71a1948528d181e743050a51e66d");
    expect(cid.startsWith("bah5acgza")).toBe(true);
    expect(cid.length).toBeLessThanOrEqual(63);
    expect(/^[a-z2-7]+$/.test(cid.slice(1))).toBe(true);
  });
  it("rejects garbage", () => {
    expect(() => refToCid("nope")).toThrow();
    expect(isSwarmRef("ab".repeat(32))).toBe(true);
    expect(isSwarmRef("ab".repeat(31))).toBe(false);
  });
  it("gateway urls are well-formed", () => {
    for (const g of GATEWAYS) {
      const u = new URL(g.url("ab".repeat(32)));
      expect(u.protocol).toBe("https:");
      expect(u.hostname.split(".")[0]!.length).toBeLessThanOrEqual(63);
    }
  });
});

describe("markdown safety", () => {
  it("drops scripts, raw html, event handlers and javascript: links", () => {
    const html = renderMarkdown(
      `Hello <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))\n\n<iframe src="https://evil"></iframe>`,
    );
    expect(html).not.toMatch(/<script|onerror|javascript:|<iframe/i);
  });
  it("only allows images from inside the snapshot", () => {
    const html = renderMarkdown("![ok](media/abc123.jpg)\n\n![tracker](https://tracker.example/pixel.png)\n\n![data](data:image/png;base64,AAAA)");
    expect(html).toContain('src="media/abc123.jpg"');
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("data:image");
  });
  it("hardens external links", () => {
    const html = renderMarkdown("[x](https://example.org)");
    expect(html).toMatch(/rel="noopener noreferrer nofollow"/);
  });
  it("renders unicode (Hindi / Urdu) text untouched", () => {
    expect(renderMarkdown("# खबर\n\nخبر")).toContain("खबर");
  });
});

describe("stamp health", () => {
  const good = { usable: true, exists: true, immutableFlag: true, depth: 20, bucketDepth: 16, utilization: 1, batchTTL: 60 * DAY };
  it("ok for a healthy batch", () => expect(assessStamp(good).level).toBe("ok"));
  it("warns when time is short, critical when very short", () => {
    expect(assessStamp({ ...good, batchTTL: 10 * DAY }).level).toBe("warn");
    expect(assessStamp({ ...good, batchTTL: 1 * DAY }).level).toBe("critical");
  });
  it("uses the fullest bucket, not total size", () => {
    // depth 20 / bucketDepth 16 => 16 slots per bucket; 15 used = 94%
    const h = assessStamp({ ...good, utilization: 15 });
    expect(h.level).toBe("critical");
    expect(h.messages[0]).toMatch(/full/);
  });
  it("flags mutable batches as critical (feeds can break)", () => {
    const h = assessStamp({ ...good, immutableFlag: false });
    expect(h.level).toBe("critical");
    expect(h.messages.join()).toMatch(/MUTABLE/);
  });
  it("handles expired / missing", () => {
    expect(assessStamp({ ...good, expired: true }).level).toBe("critical");
    expect(assessStamp({ exists: false }).level).toBe("critical");
  });
  it("does not crash on empty input", () => {
    expect(() => assessStamp({})).not.toThrow();
  });
});

describe("error explanations + retry", () => {
  it("maps common failures", () => {
    expect(explainError({ status: 402, message: "x" }).title).toMatch(/cannot be used/);
    expect(explainError(new TypeError("Failed to fetch")).transient).toBe(true);
    expect(explainError({ status: 503 }).transient).toBe(true);
    expect(explainError({ status: 422, message: "bucket is full" }).title).toMatch(/full/);
    expect(explainError({ status: 413 }).transient).toBe(false);
  });
  it("retries transient, not permanent", async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 3) throw { status: 503 };
        return "ok";
      },
      { sleep: async () => {} },
    );
    expect(out).toBe("ok");
    expect(n).toBe(3);
    let m = 0;
    await expect(
      withRetry(async () => { m++; throw { status: 402 }; }, { sleep: async () => {} }),
    ).rejects.toBeTruthy();
    expect(m).toBe(1);
  });
});

describe("snapshot builder", () => {
  const key = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const site = { schema: 1, title: "t", tagline: "", about: "", lang: "en", feed: { owner: "a".repeat(40), topic: "t", manifest: "b".repeat(64) }, createdAt: "x" };
  it("rejects path traversal and duplicates", () => {
    expect(() => assertSafePaths([{ path: "../x", bytes: new Uint8Array() }])).toThrow();
    expect(() => assertSafePaths([{ path: "a", bytes: new Uint8Array() }, { path: "a", bytes: new Uint8Array() }])).toThrow();
  });
  it("is deterministic for identical input and bumps the version", () => {
    const now = new Date("2026-11-04T10:00:00Z");
    const p = { id: "abc123", title: "T", summary: "s", kind: "article" as const, publishedAt: "2026-11-04T09:00:00Z", updatedAt: "2026-11-04T09:00:00Z", tags: [], markdown: "x" };
    const a = buildSnapshot({ site, posts: [p], media: new Map(), reader: [], previousVersion: 4, privateKeyHex: key, now });
    const b = buildSnapshot({ site, posts: [p], media: new Map(), reader: [], previousVersion: 4, privateKeyHex: key, now });
    expect(a.version).toBe(5);
    expect(a.index.posts[0]!.hash).toBe(b.index.posts[0]!.hash);
  });
  it("works with zero posts (first publish of an empty site)", () => {
    const r = buildSnapshot({ site, posts: [], media: new Map(), reader: [], previousVersion: 0, privateKeyHex: key });
    expect(r.index.posts).toEqual([]);
    expect(r.files.some((f) => f.path === "data/seal.json")).toBe(true);
  });
});

describe("ids", () => {
  it("generates safe, unique ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newPostId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(isSafeId(id)).toBe(true);
    expect(isSafeId("../etc")).toBe(false);
  });
  it("summarises markdown", () => {
    expect(summarise("# Title\n\nSome **bold** [link](http://x) text".repeat(20), 50).length).toBeLessThanOrEqual(50);
  });
});
