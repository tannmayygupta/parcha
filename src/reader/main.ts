import { fromUtf8, sha256Hex } from "../shared/bytes";
import { GATEWAYS, localNodeUrl, nativeUrl } from "../shared/gateways";
import { renderMarkdown } from "../shared/render";
import { verifySeal } from "../shared/seal";
import { isSafeId } from "../shared/ids";
import { fill, h } from "../shared/dom";
import { PATHS, type Post, type PostMeta, type PostsIndex, type Seal, type SiteMeta } from "../shared/types";
import type { Announcement } from "../live/protocol";
import { startLive, type LiveState } from "./live";

/**
 * Reader: a static page that lives INSIDE each snapshot on Swarm. It only ever talks to the
 * place it was served from (relative URLs), so it works through any gateway or a local node and
 * has no server of ours behind it.
 */

const POLL_MS = 45_000;
const root = new URL("./", location.href);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Loaded {
  site: SiteMeta;
  index: PostsIndex;
  integrity: { ok: boolean; reason?: string };
  fetchedAt: number;
  fromCache: boolean;
}

let state: Loaded | null = null;
let liveState: LiveState = "off";
let liveDetail = "";
let lastPollOk = true;

// ---- data loading ---------------------------------------------------------------------------

async function getBytes(path: string): Promise<Uint8Array> {
  const r = await fetch(new URL(path, root), { cache: "no-store", credentials: "omit" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
const parse = <T>(b: Uint8Array) => JSON.parse(fromUtf8(b)) as T;

const cacheKey = () => `parcha:${root.pathname}`;
interface CacheEntry { site: SiteMeta; index: PostsIndex; savedAt: number }
function readCache(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(cacheKey());
    return raw ? (JSON.parse(raw) as CacheEntry) : null;
  } catch {
    return null;
  }
}
function writeCache(site: SiteMeta, index: PostsIndex): void {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({ site, index, savedAt: Date.now() } satisfies CacheEntry));
  } catch {
    /* private mode / quota: caching is a nicety */
  }
}

async function fetchFresh(): Promise<Loaded> {
  const [siteB, postsB, sealB] = await Promise.all([getBytes(PATHS.site), getBytes(PATHS.posts), getBytes(PATHS.seal).catch(() => null)]);
  const site = parse<SiteMeta>(siteB);
  const index = parse<PostsIndex>(postsB);
  let integrity: Loaded["integrity"] = { ok: false, reason: "no signature found in this copy" };
  if (sealB) {
    const seal = parse<Seal>(sealB);
    const res = verifySeal(seal, postsB, site.feed.owner);
    integrity = res.ok ? { ok: true } : { ok: false, reason: res.reason };
    if (res.ok && seal.version !== index.version) integrity = { ok: false, reason: "signature belongs to a different version" };
  }
  return { site, index, integrity, fetchedAt: Date.now(), fromCache: false };
}

async function load(): Promise<void> {
  const cached = readCache();
  try {
    const fresh = await fetchFresh();
    lastPollOk = true;
    // A stale gateway can serve an older snapshot than one we already verified. Never go backwards.
    if (cached && cached.index.version > fresh.index.version) {
      state = { site: cached.site, index: cached.index, integrity: { ok: true }, fetchedAt: cached.savedAt, fromCache: true };
      notice("warn", `This gateway is serving an older version (${fresh.index.version}) than you have already seen (${cached.index.version}). Showing your newer saved copy. Try another mirror below.`);
    } else {
      state = fresh;
      if (fresh.integrity.ok) writeCache(fresh.site, fresh.index);
    }
  } catch (e) {
    lastPollOk = false;
    if (cached) {
      state = { site: cached.site, index: cached.index, integrity: { ok: true }, fetchedAt: cached.savedAt, fromCache: true };
      notice("warn", `Can't reach Swarm right now. Showing the copy saved on this device (${ago(cached.savedAt)}).`);
    } else {
      renderFatal(e as Error);
      return;
    }
  }
  render();
}

// ---- polling + live -------------------------------------------------------------------------

async function poll(reason: "timer" | "live"): Promise<void> {
  if (!state) return;
  try {
    const fresh = await fetchFresh();
    lastPollOk = true;
    if (fresh.index.version > state.index.version) {
      const newest = fresh.index.posts[0];
      state = fresh;
      if (fresh.integrity.ok) writeCache(fresh.site, fresh.index);
      clearNotices();
      render();
      toast(newest ? `New: ${newest.title}` : "The site was updated");
    } else if (state.fromCache) {
      state = fresh;
      clearNotices();
      render();
    } else {
      renderStatus();
    }
  } catch {
    lastPollOk = false;
    renderStatus();
  }
  void reason;
}

let announcedVersion = 0;
function onAnnouncement(a: Announcement): void {
  if (a.v <= (state?.index.version ?? 0) || a.v <= announcedVersion) return;
  announcedVersion = a.v;
  // The message is only a hint. Fetch and verify the real content from the feed.
  void poll("live");
}

function setupBackground(): void {
  setInterval(() => void poll("timer"), POLL_MS);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void poll("timer"));
  addEventListener("online", () => void poll("timer"));
  if (state?.site.live) {
    void startLive(state.site, onAnnouncement, (s, d) => {
      liveState = s;
      liveDetail = d ?? "";
      renderStatus();
    });
  }
}

// ---- rendering ------------------------------------------------------------------------------

const RTL = new Set(["ar", "fa", "he", "ur", "ps", "sd", "ug", "yi", "dv"]);

function render(): void {
  if (!state) return;
  const { site } = state;
  document.documentElement.lang = site.lang || "en";
  document.documentElement.dir = RTL.has((site.lang || "en").split("-")[0]!) ? "rtl" : "ltr";
  document.title = site.title;

  const mast = $("masthead");
  fill(mast,
    h("h1", {}, h("a", { href: "#/" }, site.title)),
    site.tagline ? h("p", { class: "tag" }, site.tagline) : null,
    h("div", { class: "statusbar sans", id: "statusbar" }),
  );
  renderStatus();
  renderBanners();
  renderRoute();
  renderFooter();
}

function renderStatus(): void {
  const bar = document.getElementById("statusbar");
  if (!bar || !state) return;
  const live = liveState === "live";
  const chip = h("span", { class: `chip ${live ? "live" : "poll"}`, title: liveDetail }, h("span", { class: "dot", "aria-hidden": "true" }), live ? "Live updates on" : "Checking for updates every minute");
  fill(bar,
    chip,
    h("span", {}, `Version ${state.index.version} · updated ${ago(Date.parse(state.index.publishedAt))}`),
    !lastPollOk || state.fromCache ? h("span", { class: "chip" }, "Offline copy") : null,
  );
}

/** One-off messages (offline, stale gateway). Rebuilt into the banner area on every render. */
const extraNotices: { kind: "warn" | "info"; text: string }[] = [];
function notice(kind: "warn" | "info", text: string): void {
  extraNotices.push({ kind, text });
}
function clearNotices(): void {
  extraNotices.length = 0;
}

function renderBanners(): void {
  if (!state) return;
  const box = $("banners");
  box.replaceChildren();
  // saved-copy banner: opened by snapshot reference instead of the permanent link
  const m = location.pathname.match(/\/bzz\/([0-9a-f]{64})\//);
  if (m && state.site.feed.manifest && m[1] !== state.site.feed.manifest) {
    const live = GATEWAYS[0]!.url(state.site.feed.manifest);
    box.append(h("div", { class: "warn" }, "You opened a fixed saved copy of this site, which will never update. ", h("a", { href: live }, "Open the live link instead")));
  }
  // breaking alert pinned at the top for 24 hours
  const recent = state.index.posts.find((p) => p.kind === "alert" && !p.retracted && Date.now() - Date.parse(p.publishedAt) < 86_400_000);
  if (recent) box.append(h("div", { class: "alert" }, "Breaking: ", h("a", { href: `#/p/${recent.id}` }, recent.title)));
  if (!state.integrity.ok) {
    box.append(h("div", { class: "warn" }, `Could not verify the publisher's signature on this copy: ${state.integrity.reason ?? "unknown reason"}. Treat it with care and compare with another mirror.`));
  }
  for (const n of extraNotices) box.append(h("div", { class: n.kind, role: "note" }, n.text));
}

function renderRoute(): void {
  const main = $("main");
  const route = location.hash.replace(/^#\/?/, "");
  const [kind, id] = route.split("/");
  if (kind === "p" && id && isSafeId(id)) return void renderPost(id);
  renderList();
  main.focus({ preventScroll: true });
}

function renderList(): void {
  const main = $("main");
  const posts = state!.index.posts;
  if (posts.length === 0) {
    main.replaceChildren(h("p", { class: "muted" }, "Nothing has been published yet. Check back soon."));
    return;
  }
  main.replaceChildren(...posts.map(card));
}

function card(p: PostMeta): HTMLElement {
  return h(
    "section",
    { class: "post-card" },
    h("div", { class: "meta" }, p.kind === "alert" ? h("span", { class: "kind-alert" }, "Breaking") : null, fmtDate(p.publishedAt), p.retracted ? " · Retracted" : ""),
    p.image && /^media\/[A-Za-z0-9._-]+$/.test(p.image) ? h("img", { class: "thumb", src: p.image, alt: "", loading: "lazy" }) : null,
    h("h2", {}, h("a", { href: `#/p/${p.id}` }, p.title)),
    p.summary ? h("p", {}, p.summary) : null,
  );
}

async function renderPost(id: string): Promise<void> {
  const main = $("main");
  const meta = state!.index.posts.find((p) => p.id === id);
  if (!meta) {
    main.replaceChildren(h("p", {}, "This story isn't in the current edition. "), h("a", { href: "#/" }, "Back to all stories"));
    return;
  }
  main.replaceChildren(h("p", { class: "muted" }, "Loading story…"));
  try {
    const bytes = await getBytes(PATHS.post(id));
    const hashOk = sha256Hex(bytes) === meta.hash;
    const post = parse<Post>(bytes);
    if (route() !== `p/${id}`) return; // user navigated away while loading
    const body = h("div", { class: "body" });
    body.innerHTML = renderMarkdown(post.markdown); // sanitised: see shared/render.ts
    const owner = state!.site.feed.owner;
    const verified = state!.integrity.ok && hashOk;
    main.replaceChildren(
      h(
        "article",
        {},
        h("a", { class: "back", href: "#/" }, "← All stories"),
        h("div", { class: "meta" }, post.kind === "alert" ? h("span", { class: "kind-alert" }, "Breaking") : null, fmtDate(post.publishedAt), post.updatedAt !== post.publishedAt ? ` · updated ${fmtDate(post.updatedAt)}` : ""),
        h("h1", {}, post.title),
        post.retracted ? h("p", { class: "retracted" }, `Retracted ${fmtDate(post.retracted.at)}: ${post.retracted.note}`) : null,
        body,
        h(
          "div",
          { class: `seal ${verified ? "ok" : "bad"}`, role: "note" },
          verified
            ? `✔ Verified. This story is exactly what the newsroom signed (key ${owner.slice(0, 6)}…${owner.slice(-4)}, version ${state!.index.version}).`
            : `⚠ Could not verify this story${hashOk ? "" : " (its content does not match the signed fingerprint)"}. Compare with another mirror before trusting it.`,
        ),
      ),
    );
    main.focus({ preventScroll: true });
    scrollTo(0, 0);
  } catch (e) {
    main.replaceChildren(h("p", {}, `Couldn't load this story (${(e as Error).message}). `), h("a", { href: "#/" }, "Back to all stories"));
  }
}

const route = () => location.hash.replace(/^#\/?/, "");

function renderFooter(): void {
  if (!state) return;
  const { site } = state;
  const manifest = site.feed.manifest;
  const links = GATEWAYS.map((g) => h("li", {}, h("a", { href: g.url(manifest), rel: "noopener noreferrer" }, g.label)));
  const copy = h("button", { class: "btn primary", type: "button" }, "Copy permanent link");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(GATEWAYS[0]!.url(manifest));
      toast("Link copied");
    } catch {
      toast("Select and copy the address from the list below");
    }
  });
  fill($("footer"),
    site.about ? h("p", {}, site.about) : null,
    h("h2", {}, "Share and keep this link"),
    h("p", {}, "This site is stored on Swarm, a network with no single host. There is one link, and it always shows the newest edition, even if our server or domain disappears."),
    copy,
    h("h2", {}, "If one mirror is blocked, use another"),
    h("ul", {}, ...links, h("li", {}, "Swarm-aware browsers: ", h("span", { class: "mono" }, nativeUrl(manifest))), h("li", {}, "Your own Bee node: ", h("span", { class: "mono" }, localNodeUrl(manifest)))),
    h("h2", {}, "Link fingerprint"),
    h("p", { class: "mono" }, manifest),
  );
}

function renderFatal(e: Error): void {
  document.title = "Can't load";
  $("main").replaceChildren(
    h("h1", {}, "Can't load this site right now"),
    h("p", {}, "The page loaded, but its stories didn't. Your connection may be down, or this gateway is blocking Swarm content."),
    h("p", { class: "muted mono" }, e.message),
    h("p", {}, "Try again in a minute, or open the same link through a different Swarm gateway."),
  );
}

// ---- helpers --------------------------------------------------------------------------------

function toast(text: string, action?: { label: string; run: () => void }): void {
  const box = $("toast");
  const t = h("div", { class: "t" }, h("span", {}, text));
  if (action) {
    const b = h("button", { type: "button" }, action.label);
    b.addEventListener("click", action.run);
    t.append(b);
  }
  box.replaceChildren(t);
  setTimeout(() => t.remove(), 8_000);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (!isFinite(s)) return "recently";
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: "auto" });
  if (Math.abs(s) < 60) return rtf.format(0, "second");
  if (Math.abs(s) < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (Math.abs(s) < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86400), "day");
}

// ---- boot -----------------------------------------------------------------------------------

// `/bzz/<ref>` without a trailing slash would make every relative URL resolve one level too high.
if (/\/bzz\/[0-9a-f]{64}$/.test(location.pathname)) {
  location.replace(location.pathname + "/" + location.search + location.hash);
} else {
  addEventListener("hashchange", () => {
    if (state) renderRoute();
  });
  await load();
  if (state) setupBackground();
}
