import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockBee, type MockBee } from "../scripts/mock-bee";
import { SwarmClient } from "../src/swarm/client";
import { Newsroom, defaultSite, statusOf } from "../src/publisher/newsroom";
import { preflight, publishStory, type PublishDeps } from "../src/publisher/publish";
import { restoreFromLink } from "../src/publisher/restore";
import { checkPassphrase, createKeystore, generateKey, normalizeKey, openKeystore, parseKeystore } from "../src/publisher/vault";
import { addressOf } from "../src/shared/seal";
import { decodeAnnouncement, encodeAnnouncement } from "../src/live/protocol";
import { utf8 } from "../src/shared/bytes";

const reader = [{ path: "index.html", content: "<!doctype html><title>r</title>" }];

describe("newsroom workflow end to end (mock Bee)", () => {
  let mock: MockBee;
  let client: SwarmClient;
  let nr: Newsroom;
  let key: string;
  const media = new Map<string, Uint8Array>([["media/pic1.jpg", utf8("not really a jpeg")]]);
  const announced: string[] = [];
  let deps: PublishDeps;

  beforeAll(async () => {
    mock = await startMockBee();
    client = new SwarmClient({ beeUrl: mock.url, batchId: mock.batchId });
    key = generateKey();
    nr = new Newsroom(defaultSite("The Dakiya", "hi"));
    nr.site.owner = addressOf(key);
    nr.site.manifest = await client.ensureManifest(key, nr.site.topic);
    deps = {
      newsroom: nr,
      client,
      privateKey: key,
      reader,
      getMedia: async (p) => media.get(p),
      announce: async (a) => (announced.push(a.title), { ok: true, note: "sent" }),
    };
  });
  afterAll(() => mock.close());

  it("preflight passes against a healthy node", async () => {
    const pf = await preflight(nr, client);
    expect(pf.canPublish).toBe(true);
  });

  it("preflight blocks on an unreachable node", async () => {
    const dead = new SwarmClient({ beeUrl: "http://127.0.0.1:59999", batchId: mock.batchId });
    const pf = await preflight(nr, dead);
    expect(pf.canPublish).toBe(false);
    expect(pf.blockers[0]).toMatch(/reach/i);
  });

  it("a malformed node address is reported, not thrown", async () => {
    const bad = new SwarmClient({ beeUrl: "not a url", batchId: mock.batchId });
    expect((await bad.health()).ok).toBe(false);
    const pf = await preflight(nr, bad);
    expect(pf.canPublish).toBe(false);
  });

  it("refuses to publish an empty story", async () => {
    const d = nr.newDraft();
    expect(nr.problems(d.id).length).toBe(2);
    await expect(publishStory(deps, { id: d.id })).rejects.toThrow(/headline/);
    nr.deleteDraft(d.id);
  });

  let a: string;
  let b: string;
  it("publishes a story with an image; the permanent link serves it", async () => {
    const d = nr.newDraft();
    a = d.id;
    nr.edit(a, { title: "पहली खबर", markdown: "शुरुआत ![pic](media/pic1.jpg)", image: "media/pic1.jpg" });
    const out = await publishStory(deps, { id: a });
    expect(out.confirmed).toBe(true);
    expect(out.version).toBe(1);
    expect(announced).toEqual(["पहली खबर"]);
    expect(statusOf(nr.get(a)!)).toBe("live");
    const served = await client.fetchFile(nr.site.manifest!, "media/pic1.jpg");
    expect(new TextDecoder().decode(served)).toBe("not really a jpeg");
  });

  it("editing a live story does not leak into the next publish of another story", async () => {
    nr.edit(a, { title: "पहली खबर (अधूरा संपादन)" });
    expect(statusOf(nr.get(a)!)).toBe("live-with-edits");
    const d = nr.newDraft("alert");
    b = d.id;
    nr.edit(b, { title: "Breaking", markdown: "Something happened" });
    const out = await publishStory(deps, { id: b });
    expect(out.version).toBe(2);
    const idx = await client.fetchPosts(nr.site.manifest!);
    expect(idx.posts.map((p) => p.title).sort()).toEqual(["Breaking", "पहली खबर"].sort());
    expect(announced.at(-1)).toBe("Breaking");
    // A's half-finished edit is still only local
    expect(statusOf(nr.get(a)!)).toBe("live-with-edits");
  });

  it("only uploads images that live stories use", async () => {
    nr.edit(b, { markdown: "no images here" });
    // pic1 is still used by story A
    const plan = nr.plan(b);
    expect(Newsroom.mediaUsedBy(plan).has("media/pic1.jpg")).toBe(true);
  });

  it("a missing image gives a clear error and publishes nothing", async () => {
    nr.edit(a, { markdown: "oops ![gone](media/missing.jpg)" });
    const before = mock.stats().uploads;
    await expect(publishStory(deps, { id: a })).rejects.toThrow(/missing from this device/);
    expect(mock.stats().uploads).toBe(before);
    expect(nr.site.version).toBe(2);
    nr.edit(a, { markdown: "शुरुआत ![pic](media/pic1.jpg)", title: "पहली खबर" });
  });

  it("a failed publish leaves local state untouched and can simply be retried", async () => {
    mock.failNext(10); // more failures than retries
    const v = nr.site.version;
    await expect(publishStory(deps, { id: a })).rejects.toBeTruthy();
    expect(nr.site.version).toBe(v);
    mock.failNext(0);
    const out = await publishStory(deps, { id: a });
    expect(out.confirmed).toBe(true);
    expect(nr.site.version).toBe(v + 1);
  }, 60_000);

  it("retraction keeps the text on Swarm but marks it retracted", async () => {
    await publishStory(deps, { id: b, retract: "Our source was wrong." });
    const idx = await client.fetchPosts(nr.site.manifest!);
    const m = idx.posts.find((p) => p.id === b)!;
    expect(m.retracted?.note).toBe("Our source was wrong.");
    expect(statusOf(nr.get(b)!)).toBe("retracted");
    expect(() => nr.deleteDraft(b)).toThrow(/retract/i);
  });

  it("a brand-new device restores the whole newsroom from the link + key", async () => {
    const { newsroom: restored, media: m, warnings } = await restoreFromLink(client, nr.site.manifest!, addressOf(key));
    expect(warnings).toEqual([]);
    expect(restored.site.version).toBe(nr.site.version);
    expect(restored.posts.map((p) => p.id).sort()).toEqual([a, b].sort());
    expect(m.has("media/pic1.jpg")).toBe(true);
    // and it can keep publishing on top of the restored state
    const deps2 = { ...deps, newsroom: restored };
    const out = await publishStory(deps2, { id: a });
    expect(out.version).toBe(nr.site.version + 1);
  });

  it("publishing a retracted story again clears the retraction; other stories keep theirs", async () => {
    expect(statusOf(nr.get(b)!)).toBe("retracted");
    // re-publishing another story must not silently un-retract b
    await publishStory(deps, { id: a });
    expect(statusOf(nr.get(b)!)).toBe("retracted");
    // but publishing b itself again does
    await publishStory(deps, { id: b });
    expect(statusOf(nr.get(b)!)).toBe("live");
    const idx = await client.fetchPosts(nr.site.manifest!);
    expect(idx.posts.find((p) => p.id === b)?.retracted).toBeUndefined();
  });

  it("restore refuses a link that belongs to someone else's key", async () => {
    await expect(restoreFromLink(client, nr.site.manifest!, addressOf(generateKey()))).rejects.toThrow(/different key/);
  });
});

describe("key vault", () => {
  it("round-trips and rejects a wrong passphrase", async () => {
    const key = generateKey();
    const ks = await createKeystore(key, "correct horse battery", 1000);
    expect(ks.address).toBe(addressOf(key));
    expect(await openKeystore(parseKeystore(JSON.stringify(ks)), "correct horse battery")).toBe(key);
    await expect(openKeystore(ks, "wrong passphrase!!")).rejects.toThrow(/Wrong passphrase/);
  });
  it("detects a keystore relabelled with another address", async () => {
    const ks = await createKeystore(generateKey(), "correct horse battery", 1000);
    await expect(openKeystore({ ...ks, address: addressOf(generateKey()) }, "correct horse battery")).rejects.toThrow();
  });
  it("validates imported keys and passphrases", () => {
    expect(() => normalizeKey("nope")).toThrow();
    expect(() => normalizeKey("00".repeat(32))).toThrow(); // zero is not a valid scalar
    expect(normalizeKey("0x" + "11".repeat(32))).toBe("11".repeat(32));
    expect(checkPassphrase("short")).not.toBeNull();
    expect(checkPassphrase("long enough pass")).toBeNull();
    expect(() => parseKeystore("{}")).toThrow();
    expect(() => parseKeystore("not json")).toThrow();
  });
});

describe("live announcements", () => {
  it("round-trips and caps size even for long non-latin titles", () => {
    const a = { t: "alert" as const, v: 3, id: "abc123def", title: "अ".repeat(2000), ts: "2026-11-04T10:00:00Z" };
    const text = encodeAnnouncement(a);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1024);
    const back = decodeAnnouncement(text);
    expect(back?.v).toBe(3);
    expect(back?.id).toBe("abc123def");
  });
  it("ignores malformed or hostile messages", () => {
    for (const bad of ["", "nope", "{}", '{"t":"post","v":-1,"id":"x","title":"t","ts":"x"}', '{"t":"x","v":1,"id":"abc123","title":"t","ts":"x"}', '{"t":"post","v":1,"id":"../../etc","title":"t","ts":"x"}', "x".repeat(5000)]) {
      expect(decodeAnnouncement(bad)).toBeNull();
    }
  });
});
