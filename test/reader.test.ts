// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1:18633/" }
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMockBee, type MockBee } from "../scripts/mock-bee";
import { SwarmClient } from "../src/swarm/client";
import { Newsroom, defaultSite } from "../src/publisher/newsroom";
import { publishStory } from "../src/publisher/publish";
import { generateKey } from "../src/publisher/vault";
import { addressOf } from "../src/shared/seal";
import { buildSnapshot } from "../src/shared/snapshot";
import { fromUtf8, utf8 } from "../src/shared/bytes";
import { PATHS } from "../src/shared/types";

const shell = `<a class="skip" href="#main"></a><header id="masthead"></header><div id="banners"></div><main id="main" tabindex="-1"></main><footer id="footer"></footer><div id="toast"></div>`;
const reader = [{ path: "index.html", content: "<!doctype html>" }];

let mock: MockBee;
let client: SwarmClient;
let nr: Newsroom;
let key: string;

const settle = async (ms = 300) => new Promise((r) => setTimeout(r, ms));

async function openReader(): Promise<void> {
  document.body.innerHTML = shell;
  history.pushState({}, "", `/bzz/${nr.site.manifest}/`);
  vi.resetModules();
  await import("../src/reader/main");
  await settle();
}

beforeAll(async () => {
  mock = await startMockBee({ port: 18633 });
  client = new SwarmClient({ beeUrl: mock.url, batchId: mock.batchId });
  key = generateKey();
  nr = new Newsroom(defaultSite("The Dakiya", "hi"));
  nr.site.owner = addressOf(key);
  nr.site.tagline = "खबर जो रुकती नहीं";
  nr.site.about = "A small independent newsroom.";
  nr.site.live.enabled = false;
  nr.site.manifest = await client.ensureManifest(key, nr.site.topic);
  const d = nr.newDraft();
  nr.edit(d.id, { title: "First story", markdown: "Hello **world**\n\n<script>window.pwned=1</script>\n\n[x](javascript:window.pwned=2)" });
  const deps = { newsroom: nr, client, privateKey: key, reader, getMedia: async () => undefined };
  await publishStory(deps, { id: d.id });
  const a = nr.newDraft("alert");
  nr.edit(a.id, { title: "Breaking: flood warning", markdown: "Move to higher ground." });
  await publishStory(deps, { id: a.id });
});
afterAll(() => mock.close());
beforeEach(() => localStorage.clear());

describe("reader served through the permanent link", () => {
  it("renders masthead, stories, breaking banner and mirrors", async () => {
    await openReader();
    expect(document.title).toBe("The Dakiya");
    expect(document.documentElement.lang).toBe("hi");
    expect(document.querySelector("h1")?.textContent).toBe("The Dakiya");
    const titles = Array.from(document.querySelectorAll(".post-card h2")).map((e) => e.textContent);
    expect(titles).toEqual(expect.arrayContaining(["First story", "Breaking: flood warning"]));
    expect(document.getElementById("banners")?.textContent).toMatch(/Breaking/);
    expect(document.getElementById("statusbar")?.textContent).toMatch(/Version 2/);
    const footer = document.getElementById("footer")!;
    expect(footer.textContent).toContain(nr.site.manifest);
    expect(footer.querySelectorAll("a").length).toBeGreaterThanOrEqual(2); // mirrors
  });

  it("opens a story, sanitises hostile markdown and shows a verified seal", async () => {
    await openReader();
    const first = nr.posts.find((p) => p.work.title === "First story")!;
    location.hash = `#/p/${first.id}`;
    await settle(500);
    const main = document.getElementById("main")!;
    expect(main.querySelector("h1")?.textContent).toBe("First story");
    expect(main.innerHTML).not.toMatch(/<script|javascript:/i);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    expect(main.querySelector(".seal.ok")?.textContent).toMatch(/Verified/);
  });

  it("warns when the signed index was tampered with after signing", async () => {
    // publish a snapshot whose posts.json was edited AFTER the seal was made
    const built = buildSnapshot({ site: nr.siteMeta(), posts: nr.plan(), media: new Map(), reader, previousVersion: 50, privateKeyHex: key });
    const files = built.files.map((f) =>
      f.path === PATHS.posts ? { ...f, bytes: utf8(fromUtf8(f.bytes).replace("First story", "First story (altered by a gateway)")) } : f,
    );
    await client.publish(files, { privateKeyHex: key, topic: nr.site.topic, manifest: nr.site.manifest! }, 51);
    await openReader();
    expect(document.getElementById("banners")?.textContent).toMatch(/Could not verify/);
  });

  it("falls back to the saved copy when Swarm is unreachable, and says so", async () => {
    // fresh good snapshot so there is a verified copy to cache
    await publishStory({ newsroom: nr, client, privateKey: key, reader, getMedia: async () => undefined });
    await openReader();
    expect(document.getElementById("main")!.textContent).toContain("First story");
    // take the node away
    await mock.close();
    await openReader();
    expect(document.getElementById("banners")?.textContent).toMatch(/saved on this device/);
    expect(document.getElementById("main")!.textContent).toContain("First story");
    mock = await startMockBee({ port: 18633 }); // new empty node: other tests are finished
  });

  it("shows a clear message if there is nothing cached and Swarm is down", async () => {
    await mock.close();
    await openReader();
    expect(document.getElementById("main")!.textContent).toMatch(/Can't load this site/);
    mock = await startMockBee({ port: 18633 });
  });

  it("never goes backwards: a stale gateway cannot hide a newer edition you already saw", async () => {
    // pretend we previously verified version 99
    const meta = nr.siteMeta();
    localStorage.setItem(
      `parcha:/bzz/${nr.site.manifest}/`,
      JSON.stringify({ site: meta, index: { version: 99, publishedAt: new Date().toISOString(), posts: [] }, savedAt: Date.now() }),
    );
    // the (new, empty) mock node has nothing, so re-create the link with an old version
    const client2 = new SwarmClient({ beeUrl: mock.url, batchId: mock.batchId });
    await client2.ensureManifest(key, nr.site.topic);
    nr.site.version = 0;
    await publishStory({ newsroom: nr, client: client2, privateKey: key, reader, getMedia: async () => undefined });
    await openReader();
    expect(document.getElementById("banners")?.textContent).toMatch(/older version/);
    expect(document.getElementById("statusbar")?.textContent).toMatch(/Version 99/);
  });
});
