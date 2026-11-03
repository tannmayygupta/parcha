import { addressOf } from "../shared/seal";
import { fill, h, type Child } from "../shared/dom";
import { GATEWAYS, nativeUrl } from "../shared/gateways";
import { DEFAULT_BROKER, PATHS, type PostsIndex } from "../shared/types";
import { renderMarkdown } from "../shared/render";
import { SwarmClient } from "../swarm/client";
import { explainError } from "../swarm/errors";
import { formatDuration, type StampHealth } from "../swarm/stamp-health";
import { READER_FILES } from "../generated/reader-files";
import { MAX_TITLE, Newsroom, defaultSite, statusOf, type LocalPost } from "./newsroom";
import { announceLive, preflight, publishStory } from "./publish";
import { restoreFromLink } from "./restore";
import { processImage } from "./images";
import * as store from "./store";
import { checkPassphrase, createKeystore, generateKey, normalizeKey, openKeystore, parseKeystore, type Keystore } from "./vault";

/* ------------------------------------------------------------------------------------------------
 * State
 * ---------------------------------------------------------------------------------------------- */

interface AppState {
  nr?: Newsroom;
  /** Unlocked private key: lives only in memory, never written anywhere unencrypted. */
  key?: string;
  settings: store.Settings;
}
const S: AppState = { settings: store.loadSettings() };
const app = document.getElementById("app")!;

const client = () => new SwarmClient({ beeUrl: S.settings.beeUrl, batchId: S.settings.batchId });
const isRef = (s: string) => /^[0-9a-f]{64}$/i.test(s.trim());

function persist(): void {
  if (S.nr && !store.saveSaved(S.nr.toSaved())) toast("Couldn't save on this device. Browser storage may be blocked or full.", "bad");
}

/* ------------------------------------------------------------------------------------------------
 * Small UI helpers
 * ---------------------------------------------------------------------------------------------- */

function toast(text: string, kind: "ok" | "bad" | "info" = "info"): void {
  const box = document.getElementById("toast")!;
  const t = h("div", { class: `t ${kind}`, role: kind === "bad" ? "alert" : "status" }, text);
  box.append(t);
  setTimeout(() => t.remove(), kind === "bad" ? 9000 : 4500);
}

async function copy(text: string, done = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, "ok");
  } catch {
    toast("Couldn't copy automatically. Select the text and copy it.", "bad");
  }
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const id = input.id || `f${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return h("div", { class: "field" }, h("label", { for: id }, label), input, hint ? h("p", { class: "hint", id: `${id}-hint` }, hint) : null);
}

function input(attrs: Record<string, string>): HTMLInputElement {
  return h("input", attrs);
}

function btn(label: string, cls: string, onClick: (b: HTMLButtonElement) => void | Promise<void>): HTMLButtonElement {
  const b = h("button", { type: "button", class: `btn ${cls}` }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await onClick(b);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function errorBox(e: unknown): HTMLElement {
  const f = explainError(e);
  return h("div", { class: "box bad", role: "alert" }, h("strong", {}, f.title), h("p", {}, f.advice), f.detail ? h("details", {}, h("summary", {}, "Technical details"), h("pre", {}, f.detail)) : null);
}

function page(...kids: Child[]): void {
  const prev = document.querySelector("dialog[open]") as HTMLDialogElement | null;
  prev?.close();
  fill(app, ...kids);
  window.scrollTo(0, 0);
  (document.getElementById("app") as HTMLElement).focus({ preventScroll: true });
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function modal(title: string, body: HTMLElement): HTMLDialogElement {
  const d = h("dialog", { "aria-labelledby": "dlg-title" });
  const close = h("button", { type: "button", class: "btn ghost", "aria-label": "Close" }, "Close");
  close.addEventListener("click", () => d.close());
  d.append(h("div", { class: "dlg-head" }, h("h2", { id: "dlg-title" }, title), close), body);
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const LANGS: [string, string][] = [
  ["en", "English"], ["hi", "हिन्दी (Hindi)"], ["ur", "اردو (Urdu)"], ["bn", "বাংলা (Bengali)"], ["ta", "தமிழ் (Tamil)"],
  ["te", "తెలుగు (Telugu)"], ["mr", "मराठी (Marathi)"], ["gu", "ગુજરાતી (Gujarati)"], ["kn", "ಕನ್ನಡ (Kannada)"],
  ["ml", "മലയാളം (Malayalam)"], ["pa", "ਪੰਜਾਬੀ (Punjabi)"], ["or", "ଓଡ଼ିଆ (Odia)"],
];

/* ------------------------------------------------------------------------------------------------
 * Boot
 * ---------------------------------------------------------------------------------------------- */

export async function boot(): Promise<void> {
  if (!store.storageAvailable()) {
    document.getElementById("banner")!.replaceChildren(
      h("div", { class: "box bad", role: "alert" }, "Your browser is blocking local storage (private window?). Parcha can't keep your key or drafts on this device. Use a normal window, or export your key backup before closing."),
    );
  }
  const ks = store.loadKeystore();
  const saved = store.loadSaved();
  if (ks && saved) {
    S.nr = Newsroom.fromSaved(saved);
    return viewUnlock(ks);
  }
  viewWelcome();
}

/* ------------------------------------------------------------------------------------------------
 * Welcome / Setup / Restore / Unlock
 * ---------------------------------------------------------------------------------------------- */

function viewWelcome(): void {
  page(
    h("section", { class: "hero" },
      h("p", { class: "eyebrow" }, "Parcha"),
      h("h1", {}, "A newsroom that can't be switched off."),
      h("p", { class: "lead" }, "Write your stories here. Publish them to Swarm, a network with no single host. Readers get one link that always shows your latest work, even if your server, your domain or your website is taken down."),
      h("div", { class: "row" },
        btn("Start a new newsroom", "primary", () => viewSetup()),
        btn("I already have a newsroom (restore)", "", () => viewRestore()),
      ),
    ),
    h("section", { class: "cols" },
      h("div", {}, h("h3", {}, "No server to seize"), h("p", {}, "Your site and your link are stored across many independent computers.")),
      h("div", {}, h("h3", {}, "You hold the only key"), h("p", {}, "Only your key can update the link. It never leaves your device.")),
      h("div", {}, h("h3", {}, "Readers can verify"), h("p", {}, "Every edition is signed, so readers can tell a real story from a forgery.")),
    ),
  );
}

function viewSetup(): void {
  const name = input({ type: "text", maxlength: "80", placeholder: "e.g. Dakiya Daily", autocomplete: "off" });
  const tagline = input({ type: "text", maxlength: "140", placeholder: "One line about what you report on" });
  const lang = h("select", {}, ...LANGS.map(([c, l]) => h("option", { value: c }, l)));
  const pass = input({ type: "password", autocomplete: "new-password", minlength: "10" });
  const pass2 = input({ type: "password", autocomplete: "new-password" });
  const importKey = input({ type: "password", autocomplete: "off", placeholder: "Leave empty to create a new key", spellcheck: "false" });
  const bee = input({ type: "url", value: S.settings.beeUrl, spellcheck: "false", placeholder: "http://localhost:1633" });
  const batch = input({ type: "text", value: S.settings.batchId, spellcheck: "false", placeholder: "64-character batch ID", autocomplete: "off" });
  const out = h("div", { "aria-live": "polite" });

  const submit = btn("Create my permanent link", "primary big", async (b) => {
    fill(out);
    try {
      if (!name.value.trim()) throw new Error("Give your newsroom a name.");
      const pErr = checkPassphrase(pass.value);
      if (pErr) throw new Error(pErr);
      if (pass.value !== pass2.value) throw new Error("The two passphrases don't match.");
      let key: string;
      key = importKey.value.trim() ? normalizeKey(importKey.value) : generateKey();
      const settings = { beeUrl: bee.value.trim().replace(/\/+$/, ""), batchId: batch.value.trim().toLowerCase() };
      if (!isRef(settings.batchId)) throw new Error("The storage batch ID is 64 characters (letters a-f and digits).");
      S.settings = settings;

      b.textContent = "Checking the Swarm node…";
      const c = client();
      const health = await c.health();
      if (!health.ok) throw new Error(`Can't reach the Swarm node at ${settings.beeUrl} (${health.note}). Check the address and that the node allows requests from this page.`);
      const stamp = await c.stamp().catch(() => null);
      if (stamp && !stamp.usable) throw new Error(stamp.messages[0] ?? "That storage batch can't be used yet.");

      b.textContent = "Securing your key…";
      const ks = await createKeystore(key, pass.value);

      const nr = new Newsroom(defaultSite(name.value.trim(), lang.value));
      nr.site.tagline = tagline.value.trim();
      nr.site.owner = addressOf(key);
      b.textContent = "Creating your permanent link on Swarm…";
      nr.site.manifest = await c.ensureManifest(key, nr.site.topic);

      store.saveSettings(settings);
      store.saveKeystore(ks);
      S.nr = nr;
      S.key = key;
      persist();
      toast("Your permanent link is ready", "ok");
      viewDashboard(true);
    } catch (e) {
      fill(out, e instanceof Error && !("status" in e) && !/fetch|network/i.test(e.message) ? h("div", { class: "box bad", role: "alert" }, e.message) : errorBox(e));
      b.textContent = "Create my permanent link";
    }
  });

  page(
    h("p", {}, btn("← Back", "ghost", () => viewWelcome())),
    h("h1", {}, "Set up your newsroom"),
    h("section", { class: "card" },
      h("h2", {}, "1. About your newsroom"),
      field("Name", name),
      field("Tagline (optional)", tagline),
      field("Language", lang, "Sets the reading direction and date format for your readers."),
    ),
    h("section", { class: "card" },
      h("h2", {}, "2. Your key"),
      h("p", {}, "Your key is what proves the newsroom is you. Only it can update your permanent link. We'll create one and lock it with a passphrase. You'll download a backup next."),
      field("Passphrase", pass, "At least 10 characters. A few random words work well. We can't recover it for you."),
      field("Repeat passphrase", pass2),
      h("details", {}, h("summary", {}, "I already have a key (advanced)"), field("Private key (hex)", importKey, "Only paste a key you generated for this newsroom.")),
    ),
    h("section", { class: "card" },
      h("h2", {}, "3. Storage"),
      h("p", {}, "Swarm keeps your stories while a prepaid storage batch is active. Enter your Swarm node address and batch ID."),
      field("Swarm node address", bee, "Your own Bee node, or a gateway that accepts uploads."),
      field("Storage batch ID", batch, "It must be an immutable batch. We'll check."),
    ),
    out,
    submit,
  );
}

function viewRestore(): void {
  const link = input({ type: "text", placeholder: "Paste your 64-character link code, or the full link", spellcheck: "false" });
  const file = input({ type: "file", accept: ".json,application/json" });
  const rawKey = input({ type: "password", autocomplete: "off", placeholder: "or paste your private key", spellcheck: "false" });
  const pass = input({ type: "password", autocomplete: "current-password" });
  const bee = input({ type: "url", value: S.settings.beeUrl, spellcheck: "false" });
  const batch = input({ type: "text", value: S.settings.batchId, spellcheck: "false", placeholder: "64-character batch ID (needed to publish)" });
  const out = h("div", { "aria-live": "polite" });

  const go = btn("Restore newsroom", "primary big", async (b) => {
    fill(out);
    try {
      const m = link.value.match(/[0-9a-fA-F]{64}/);
      if (!m) throw new Error("Paste the 64-character code from your permanent link.");
      const manifest = m[0].toLowerCase();
      let key: string;
      let ks: Keystore | undefined;
      const f = file.files?.[0];
      if (f) {
        ks = parseKeystore(await f.text());
        key = await openKeystore(ks, pass.value);
      } else if (rawKey.value.trim()) {
        key = normalizeKey(rawKey.value);
      } else throw new Error("Choose your keystore backup file, or paste your private key.");
      if (!ks) {
        const pErr = checkPassphrase(pass.value);
        if (pErr) throw new Error(`Choose a passphrase to protect the key on this device. ${pErr}`);
      }
      S.settings = { beeUrl: bee.value.trim().replace(/\/+$/, ""), batchId: batch.value.trim().toLowerCase() };
      b.textContent = "Downloading from Swarm…";
      const c = client();
      const res = await restoreFromLink(c, manifest, addressOf(key));
      for (const [path, bytes] of (res.media as Map<string, Uint8Array>)) await store.putMedia(path, bytes);
      store.saveSettings(S.settings);
      store.saveKeystore(ks ?? (await createKeystore(key, pass.value)));
      S.nr = res.newsroom;
      S.key = key;
      persist();
      toast(`Restored ${res.newsroom.posts.length} stories`, "ok");
      if (res.warnings.length) toast(res.warnings[0]!, "bad");
      viewDashboard();
    } catch (e) {
      fill(out, e instanceof Error && !("status" in e) && !/fetch|network/i.test(e.message) ? h("div", { class: "box bad", role: "alert" }, e.message) : errorBox(e));
      b.textContent = "Restore newsroom";
    }
  });

  page(
    h("p", {}, btn("← Back", "ghost", () => viewWelcome())),
    h("h1", {}, "Restore your newsroom"),
    h("p", {}, "New laptop, cleared browser, lost phone? Your stories live on Swarm. With your link and your key, everything comes back."),
    h("section", { class: "card" },
      field("Your permanent link", link),
      field("Key backup file", file, "The .keystore.json you downloaded when you set up."),
      field("…or private key", rawKey),
      field("Passphrase", pass, "The passphrase of the backup file, or a new one to protect a pasted key on this device."),
      field("Swarm node address", bee),
      field("Storage batch ID", batch),
    ),
    out,
    go,
  );
}

function viewUnlock(ks: Keystore): void {
  const pass = input({ type: "password", autocomplete: "current-password" });
  const out = h("div", { "aria-live": "polite" });
  const form = h("form", {}, field("Passphrase", pass), out, h("button", { class: "btn primary big", type: "submit" }, "Unlock"));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    fill(out);
    try {
      S.key = await openKeystore(ks, pass.value);
      if (S.nr?.site.owner && S.nr.site.owner !== addressOf(S.key)) throw new Error("This key doesn't match the newsroom saved on this device.");
      viewDashboard();
    } catch (e) {
      fill(out, h("div", { class: "box bad", role: "alert" }, (e as Error).message));
    }
  });
  page(
    h("h1", {}, S.nr?.site.title || "Parcha"),
    h("p", {}, "Unlock your newsroom. Your key stays on this device."),
    form,
    h("p", { class: "hint" }, "Forgot your passphrase? Restore from your key backup instead: ", btn("Restore from backup", "ghost", () => viewRestore())),
  );
  pass.focus();
}

/* ------------------------------------------------------------------------------------------------
 * Dashboard
 * ---------------------------------------------------------------------------------------------- */

function stampLine(s: StampHealth): string {
  return `${formatDuration(s.ttlSeconds)} of storage left · ${Math.round(s.usage * 100)}% full`;
}

function viewDashboard(justCreated = false): void {
  const nr = S.nr!;
  const manifest = nr.site.manifest!;
  const link = GATEWAYS[0]!.url(manifest);

  const stampBox = h("div", { class: "chip", "aria-live": "polite" }, "Checking storage…");
  client().stamp().then(
    (s) => {
      stampBox.className = `chip ${s.level}`;
      fill(stampBox, `Storage: ${stampLine(s)}`);
      if (s.messages.length) stampBox.title = s.messages.join("\n");
      if (s.level !== "ok") document.getElementById("alerts")?.prepend(h("div", { class: `box ${s.level === "critical" ? "bad" : "warn"}`, role: "alert" }, ...s.messages.map((m) => h("p", {}, m))));
    },
    () => fill(stampBox, "Storage status unavailable"),
  );

  const verifyOut = h("div", { class: "verify", "aria-live": "polite" });
  const verify = btn("Check the link on every mirror", "", async () => {
    fill(verifyOut, h("p", { class: "hint" }, "Asking each mirror for your latest edition…"));
    const rows = await Promise.all(GATEWAYS.map(async (g) => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 15000);
        const r = await fetch(new URL(PATHS.posts, g.url(manifest)), { cache: "no-store", signal: ctl.signal });
        clearTimeout(t);
        if (!r.ok) return h("li", { class: "bad" }, `${g.label}: not available (HTTP ${r.status})`);
        const idx = (await r.json()) as PostsIndex;
        const behind = idx.version < nr.site.version;
        return h("li", { class: behind ? "warn" : "ok" }, `${g.label}: serving version ${idx.version}${behind ? ` (yours is ${nr.site.version}, it may still be catching up)` : " ✔"}`);
      } catch {
        return h("li", { class: "warn" }, `${g.label}: couldn't be checked from this page (it may block browser checks, try opening it)`);
      }
    }));
    fill(verifyOut, h("ul", {}, ...rows));
  });

  const stories = nr.posts.length === 0
    ? [h("p", { class: "hint" }, "No stories yet. Write your first one.")]
    : nr.posts.map((p) => storyRow(p));

  page(
    h("header", { class: "bar" },
      h("div", {}, h("h1", {}, nr.site.title), nr.site.tagline ? h("p", { class: "hint" }, nr.site.tagline) : null),
      h("div", { class: "row" }, stampBox, btn("Settings", "ghost", () => viewSettings())),
    ),
    h("div", { id: "alerts" }),
    store.backupAcknowledged() ? null : h("div", { class: "box warn" },
      h("strong", {}, "Back up your key now. "),
      "If you lose this device you will not be able to update your link. ",
      btn("Download key backup", "primary", () => exportKeystore()),
    ),
    h("section", { class: `card link ${justCreated ? "new" : ""}` },
      h("h2", {}, "Your permanent link"),
      h("p", { class: "hint" }, "Share this. It always shows your latest edition, and keeps working if your own server or domain disappears."),
      h("p", { class: "mono big" }, h("a", { href: link, target: "_blank", rel: "noopener" }, link)),
      h("div", { class: "row" },
        btn("Copy link", "primary", () => copy(link, "Link copied")),
        h("a", { class: "btn", href: link, target: "_blank", rel: "noopener" }, "Open"),
        btn("Copy bzz:// address", "", () => copy(nativeUrl(manifest), "Copied")),
        verify,
      ),
      verifyOut,
      h("details", {}, h("summary", {}, "Other mirrors"), h("ul", {}, ...GATEWAYS.map((g) => h("li", {}, h("a", { href: g.url(manifest), target: "_blank", rel: "noopener" }, g.label))))),
    ),
    h("div", { class: "row spread" },
      h("h2", {}, "Stories"),
      h("div", { class: "row" },
        btn("+ New story", "primary", () => viewEditor(nr.newDraft().id)),
        btn("+ Breaking alert", "danger", () => viewEditor(nr.newDraft("alert").id)),
      ),
    ),
    h("div", { class: "stories" }, ...stories),
  );
}

function storyRow(p: LocalPost): HTMLElement {
  const st = statusOf(p);
  const label = { draft: "Draft", live: "Live", "live-with-edits": "Live · unpublished edits", retracted: "Retracted" }[st];
  const a = h("a", { href: "#", class: "story-title" }, p.work.title || "(untitled)");
  a.addEventListener("click", (ev) => {
    ev.preventDefault();
    viewEditor(p.id);
  });
  return h("div", { class: "story" },
    h("div", {}, a, h("div", { class: "meta" }, p.work.kind === "alert" ? "Breaking · " : "", new Date(p.editedAt).toLocaleString())),
    h("span", { class: `badge ${st}` }, label),
  );
}

async function exportKeystore(): Promise<void> {
  const ks = store.loadKeystore();
  if (!ks) return void toast("No key found on this device.", "bad");
  download(`${(S.nr?.site.title || "newsroom").replace(/[^\p{L}\p{N}]+/gu, "-")}.keystore.json`, JSON.stringify(ks, null, 2));
  store.setBackupAcknowledged();
  toast("Backup downloaded. Keep it somewhere safe and private, and remember your passphrase.", "ok");
  if (document.querySelector(".bar")) viewDashboard();
}

/* ------------------------------------------------------------------------------------------------
 * Editor
 * ---------------------------------------------------------------------------------------------- */

function viewEditor(id: string): void {
  const nr = S.nr!;
  const post = nr.get(id)!;
  const w = post.work;

  const title = input({ type: "text", value: w.title, maxlength: String(MAX_TITLE), placeholder: "Headline", class: "headline", "aria-label": "Headline" });
  const body = h("textarea", { rows: "16", placeholder: "Write your story. Markdown works: # heading, **bold**, > quote, [link](https://…)", "aria-label": "Story text" });
  body.value = w.markdown;
  const preview = h("div", { class: "preview body", "aria-label": "Preview" });
  const kind = h("select", { "aria-label": "Type" }, h("option", { value: "article" }, "Story"), h("option", { value: "alert" }, "Breaking alert"));
  kind.value = w.kind;
  const status = h("span", { class: "hint", "aria-live": "polite" });
  const lang = nr.site.lang;
  body.lang = lang;
  title.lang = lang;

  let timer: number | undefined;
  const sync = () => {
    nr.edit(id, { title: title.value, markdown: body.value, kind: kind.value as "article" | "alert" });
    preview.innerHTML = renderMarkdown(body.value); // sanitised
    // preview shows local images
    preview.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      void store.getMedia(src).then((bytes) => bytes && img.setAttribute("src", URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" }))));
    });
    status.textContent = "Saving…";
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      persist();
      status.textContent = "Saved on this device";
    }, 400);
  };
  for (const el of [title, body, kind]) el.addEventListener("input", sync);
  sync();
  status.textContent = "";

  const addImage = async (file: File) => {
    try {
      const img = await processImage(file);
      await store.putMedia(img.path, img.bytes);
      const md = `\n\n![](${img.path})\n\n`;
      const pos = body.selectionStart ?? body.value.length;
      body.value = body.value.slice(0, pos) + md + body.value.slice(pos);
      if (!nr.get(id)!.work.image) nr.edit(id, { image: img.path });
      sync();
      toast(`Image added (${fmtBytes(img.originalBytes)} → ${fmtBytes(img.bytes.length)}, location data removed)`, "ok");
    } catch (e) {
      toast((e as Error).message, "bad");
    }
  };
  const picker = input({ type: "file", accept: "image/*", class: "visually-hidden", "aria-label": "Add an image" });
  picker.addEventListener("change", () => {
    const f = picker.files?.[0];
    if (f) void addImage(f);
    picker.value = "";
  });
  body.addEventListener("paste", (ev) => {
    const f = Array.from(ev.clipboardData?.files ?? []).find((x) => x.type.startsWith("image/"));
    if (f) {
      ev.preventDefault();
      void addImage(f);
    }
  });

  const live = post.live;
  const st = statusOf(post);
  const publishLabel = st === "draft" ? "Publish" : st === "retracted" ? "Publish again" : "Publish update";

  page(
    h("div", { class: "row spread" },
      btn("← All stories", "ghost", () => { persist(); viewDashboard(); }),
      h("span", { class: `badge ${st}` }, { draft: "Draft", live: "Live", "live-with-edits": "Live · unpublished edits", retracted: "Retracted" }[st]),
    ),
    title,
    h("div", { class: "row" }, kind, btn("Add image", "", () => picker.click()), picker, status),
    h("div", { class: "editor" }, body, h("div", {}, h("p", { class: "eyebrow" }, "Preview"), preview)),
    h("div", { class: "row spread" },
      h("div", { class: "row" },
        btn(publishLabel, "primary big", () => { persist(); openPublish(id); }),
        live && !live.retracted ? btn("Retract", "danger", () => openRetract(id)) : null,
      ),
      !live ? btn("Delete draft", "ghost danger-text", () => {
        if (confirm("Delete this draft? This can't be undone.")) {
          nr.deleteDraft(id);
          persist();
          viewDashboard();
        }
      }) : null,
    ),
  );
}

/* ------------------------------------------------------------------------------------------------
 * Publish / retract dialogs
 * ---------------------------------------------------------------------------------------------- */

async function openPublish(id: string, retract?: string): Promise<void> {
  const nr = S.nr!;
  const key = S.key!;
  const body = h("div", {});
  const dlg = modal(retract !== undefined ? "Retract story" : "Publish to Swarm", body);
  fill(body, h("p", { class: "hint" }, "Checking your connection and storage…"));

  const problems = retract !== undefined ? [] : nr.problems(id);
  const pf = await preflight(nr, client());
  const warnings = pf.warnings;
  const blockers = [...problems, ...pf.blockers];
  if (blockers.length) {
    fill(body, h("div", { class: "box bad", role: "alert" }, h("strong", {}, "Not ready yet"), h("ul", {}, ...blockers.map((b) => h("li", {}, b)))), btn("Close", "", () => dlg.close()));
    return;
  }

  const plan = nr.plan(id, retract !== undefined ? { retract } : {});
  let sizeNote = "";
  try {
    const built = await nr.buildFiles(plan, store.getMedia, READER_FILES, key);
    sizeNote = `${built.files.length} files, ${fmtBytes(built.files.reduce((n, f) => n + f.bytes.length, 0))}`;
  } catch (e) {
    fill(body, h("div", { class: "box bad", role: "alert" }, (e as Error).message), btn("Close", "", () => dlg.close()));
    return;
  }

  const permanent = h("input", { type: "checkbox", id: "perm" });
  const backup = h("input", { type: "checkbox", id: "bk" });
  const needBackup = !store.backupAcknowledged();
  const go = btn(retract !== undefined ? "Retract and publish" : "Publish now", "primary big", async (b) => {
    if (!permanent.checked || (needBackup && !backup.checked)) return void toast("Please tick the boxes above first.", "bad");
    if (needBackup) store.setBackupAcknowledged();
    const progress = h("p", { "aria-live": "polite" }, "Starting…");
    fill(body, h("h3", {}, "Publishing…"), progress, h("p", { class: "hint" }, "Keep this tab open. Your story is safe on this device if anything goes wrong."));
    try {
      const out = await publishStory(
        {
          newsroom: nr, client: client(), privateKey: key, reader: READER_FILES, getMedia: store.getMedia,
          announce: (a) => announceLive({ broker: nr.site.live.broker, topic: `${nr.site.topic}-live` }, key, a),
          onProgress: (p) => (progress.textContent = p.message),
        },
        { id, ...(retract !== undefined ? { retract } : {}) },
      );
      persist();
      const link = GATEWAYS[0]!.url(nr.site.manifest!);
      fill(body,
        h("div", { class: `box ${out.confirmed ? "ok" : "warn"}`, role: "status" },
          h("strong", {}, out.confirmed ? "Published. Your link now shows it." : "Published, but the link hasn't caught up yet."),
          h("p", {}, out.confirmed ? `Version ${out.version} is live (${out.fileCount} files, ${fmtBytes(out.bytes)}).` : `${out.confirmNote}. Swarm can take a minute; the story is stored. Use "Check the link on every mirror" in a moment.`),
          h("p", { class: "hint" }, out.live.ok ? "Readers who have the page open were alerted instantly." : out.live.note),
        ),
        h("div", { class: "row" }, h("a", { class: "btn primary", href: link, target: "_blank", rel: "noopener" }, "Open your link"), btn("Copy link", "", () => copy(link)), btn("Done", "", () => { dlg.close(); viewDashboard(); })),
      );
    } catch (e) {
      fill(body, errorBox(e), h("p", {}, "Nothing was changed on your link. Your story is still here."), btn("Close", "", () => dlg.close()));
    }
  });

  fill(body,
    retract !== undefined
      ? h("p", {}, "Readers will see a retraction notice on this story. The original text stays visible on Swarm, because nothing can be erased from it.")
      : h("p", {}, h("strong", {}, plan.find((p) => p.id === id)?.title ?? ""), h("br"), h("span", { class: "hint" }, sizeNote)),
    ...warnings.map((m) => h("div", { class: "box warn" }, m)),
    h("label", { class: "check" }, permanent, h("span", {}, " I understand that publishing is ", h("strong", {}, "permanent"), ": Swarm cannot delete it, I can only retract with a notice.")),
    needBackup ? h("label", { class: "check" }, backup, h("span", {}, " I have saved a backup of my key. ", btn("Download it now", "ghost", () => exportKeystore()))) : null,
    go,
  );
}

function openRetract(id: string): void {
  const note = h("textarea", { rows: "3", placeholder: "Reason shown to readers, e.g. “Our source was wrong. The claim in paragraph 2 is false.”", "aria-label": "Retraction note" });
  const body = h("div", {}, field("Note to readers", note), btn("Continue", "danger", () => {
    document.querySelector("dialog")?.close();
    void openPublish(id, note.value);
  }));
  modal("Retract story", body);
}

/* ------------------------------------------------------------------------------------------------
 * Settings
 * ---------------------------------------------------------------------------------------------- */

function viewSettings(): void {
  const nr = S.nr!;
  const bee = input({ type: "url", value: S.settings.beeUrl, spellcheck: "false" });
  const batch = input({ type: "text", value: S.settings.batchId, spellcheck: "false" });
  const liveOn = h("input", { type: "checkbox", id: "live" });
  liveOn.checked = nr.site.live.enabled;
  const broker = input({ type: "text", value: nr.site.live.broker, spellcheck: "false" });
  const about = h("textarea", { rows: "3", maxlength: "600" });
  about.value = nr.site.about;
  const tag = input({ type: "text", value: nr.site.tagline, maxlength: "140" });
  const out = h("div", { "aria-live": "polite" });

  const test = btn("Test connection", "", async () => {
    S.settings = { beeUrl: bee.value.trim().replace(/\/+$/, ""), batchId: batch.value.trim().toLowerCase() };
    fill(out, h("p", { class: "hint" }, "Testing…"));
    const c = client();
    const health = await c.health();
    if (!health.ok) return void fill(out, h("div", { class: "box bad" }, `Can't reach the node: ${health.note}`));
    try {
      const s = await c.stamp();
      fill(out, h("div", { class: `box ${s.level === "ok" ? "ok" : s.level === "warn" ? "warn" : "bad"}` }, h("strong", {}, `Node reachable (${health.note}). ${stampLine(s)}`), ...s.messages.map((m) => h("p", {}, m))));
    } catch (e) {
      fill(out, errorBox(e));
    }
  });
  const testLive = btn("Test live channel", "", async () => {
    fill(out, h("p", { class: "hint" }, "Connecting to the live broker…"));
    const r = await announceLive({ broker: broker.value.trim(), topic: `${nr.site.topic}-live` }, S.key!, { t: "post", v: 0 + 1, id: "testtest", title: "connection test", ts: new Date().toISOString() });
    fill(out, h("div", { class: `box ${r.ok ? "ok" : "warn"}` }, r.ok ? "Live channel works." : r.note));
  });

  const save = btn("Save settings", "primary", () => {
    S.settings = { beeUrl: bee.value.trim().replace(/\/+$/, ""), batchId: batch.value.trim().toLowerCase() };
    if (S.settings.batchId && !isRef(S.settings.batchId)) return void toast("The batch ID must be 64 hex characters.", "bad");
    store.saveSettings(S.settings);
    nr.site.live = { enabled: liveOn.checked, broker: broker.value.trim() || DEFAULT_BROKER };
    nr.site.about = about.value.trim();
    nr.site.tagline = tag.value.trim();
    persist();
    toast("Saved. Changes to the About text appear on your site with your next publish.", "ok");
  });

  const resync = btn("Re-publish site now", "", async () => {
    if (!confirm("Re-publish the site as it is? Useful after changing the About text.")) return;
    try {
      const pf = await preflight(nr, client());
      if (!pf.canPublish) throw new Error(pf.blockers.join(" "));
      const o = await publishStory({ newsroom: nr, client: client(), privateKey: S.key!, reader: READER_FILES, getMedia: store.getMedia });
      persist();
      toast(o.confirmed ? `Version ${o.version} is live` : "Published; the link is still catching up", o.confirmed ? "ok" : "info");
    } catch (e) {
      toast(explainError(e).title + ": " + explainError(e).advice, "bad");
    }
  });

  page(
    btn("← Back", "ghost", () => viewDashboard()),
    h("h1", {}, "Settings"),
    h("section", { class: "card" },
      h("h2", {}, "Swarm storage"),
      field("Swarm node address", bee),
      field("Storage batch ID", batch, "Use an immutable batch. Top up before it runs out."),
      h("div", { class: "row" }, test),
    ),
    h("section", { class: "card" },
      h("h2", {}, "About your site"),
      field("Tagline", tag),
      field("About (shown in the footer)", about),
      resync,
    ),
    h("section", { class: "card" },
      h("h2", {}, "Live alerts"),
      h("label", { class: "check" }, liveOn, h("span", {}, " Alert readers instantly when I publish")),
      field("Broker address", broker, "Optional. If it's down, readers still get your stories within a minute."),
      testLive,
    ),
    out,
    save,
    h("section", { class: "card" },
      h("h2", {}, "Your key"),
      h("p", {}, "Address: ", h("span", { class: "mono" }, nr.site.owner ?? "")),
      h("div", { class: "row" }, btn("Download key backup", "primary", () => exportKeystore()), btn("Lock", "", () => { S.key = undefined; const ks = store.loadKeystore(); if (ks) viewUnlock(ks); })),
    ),
    h("section", { class: "card danger" },
      h("h2", {}, "Remove from this device"),
      h("p", {}, "Deletes the key, drafts and images stored in this browser. Your published site stays on Swarm. You can restore it with your link and key backup."),
      btn("Remove everything from this device", "danger", () => {
        if (confirm("Remove your key and drafts from this device? Make sure you have a key backup.")) {
          store.wipeLocal();
          S.nr = undefined;
          S.key = undefined;
          viewWelcome();
        }
      }),
    ),
  );
}

(window as unknown as { parcha: unknown }).parcha = { state: S };
