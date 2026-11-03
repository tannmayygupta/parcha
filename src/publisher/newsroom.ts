/**
 * The newsroom's working state, independent of the browser (so it can be unit-tested):
 * posts with a private working copy and an optional LIVE copy.
 *
 * Why two copies: a journalist can keep editing a published story without those half-finished
 * edits leaking when they publish a different story. Publishing story X puts X's working copy
 * live and leaves every other story as it was.
 */
import { isSafeId, newPostId, nowIso, summarise } from "../shared/ids";
import { buildSnapshot, type BundledFile } from "../shared/snapshot";
import type { Post, PostKind, PostMeta, PostsIndex, SiteMeta } from "../shared/types";
import { DEFAULT_BROKER } from "../shared/types";

export interface SiteConfig {
  title: string;
  tagline: string;
  about: string;
  lang: string;
  /** Feed topic, fixed for the life of the link. */
  topic: string;
  /** Feed manifest ref once the permanent link exists. */
  manifest?: string;
  owner?: string;
  /** Last published version number (0 = never published). */
  version: number;
  createdAt: string;
  live: { enabled: boolean; broker: string };
}

export interface WorkingCopy {
  title: string;
  summary: string;
  kind: PostKind;
  tags: string[];
  image?: string;
  markdown: string;
}

export interface LocalPost {
  id: string;
  work: WorkingCopy;
  live?: Post;
  createdAt: string;
  editedAt: string;
}

export interface Saved {
  site: SiteConfig;
  posts: LocalPost[];
}

export const MAX_TITLE = 200;
export const MAX_POST_BYTES = 512 * 1024;

export function defaultSite(title = "", lang = "en"): SiteConfig {
  return {
    title,
    tagline: "",
    about: "",
    lang,
    topic: `parcha-${crypto.randomUUID().slice(0, 8)}`,
    version: 0,
    createdAt: nowIso(),
    live: { enabled: true, broker: DEFAULT_BROKER },
  };
}

export type PostStatus = "draft" | "live" | "live-with-edits" | "retracted";

export function statusOf(p: LocalPost): PostStatus {
  if (!p.live) return "draft";
  if (p.live.retracted) return "retracted";
  return sameWork(p.work, p.live) ? "live" : "live-with-edits";
}

function sameWork(w: WorkingCopy, l: Post): boolean {
  return (
    w.title === l.title &&
    w.markdown === l.markdown &&
    w.summary === l.summary &&
    w.kind === l.kind &&
    (w.image ?? "") === (l.image ?? "") &&
    w.tags.join("\u0000") === l.tags.join("\u0000")
  );
}

export class Newsroom {
  constructor(public site: SiteConfig, public posts: LocalPost[] = []) {}

  static fromSaved(s: Saved): Newsroom {
    return new Newsroom(s.site, s.posts);
  }
  toSaved(): Saved {
    return { site: this.site, posts: this.posts };
  }

  get(id: string): LocalPost | undefined {
    return this.posts.find((p) => p.id === id);
  }

  newDraft(kind: PostKind = "article"): LocalPost {
    const now = nowIso();
    const p: LocalPost = { id: newPostId(), work: { title: "", summary: "", kind, tags: [], markdown: "" }, createdAt: now, editedAt: now };
    this.posts.unshift(p);
    return p;
  }

  /** Update the working copy. Summary is derived from the text unless the writer set one. */
  edit(id: string, patch: Partial<WorkingCopy>): LocalPost {
    const p = this.must(id);
    p.work = { ...p.work, ...patch };
    if (patch.markdown !== undefined && !patch.summary) p.work.summary = summarise(p.work.markdown);
    p.editedAt = nowIso();
    return p;
  }

  /** Drafts can be deleted. Live stories cannot: Swarm cannot erase them, so we retract instead. */
  deleteDraft(id: string): void {
    const p = this.must(id);
    if (p.live) throw new Error("A published story can't be deleted from Swarm. Retract it instead.");
    this.posts = this.posts.filter((x) => x.id !== id);
  }

  /** Why this story can't be published yet, or null if it can. */
  problems(id: string): string[] {
    const w = this.must(id).work;
    const out: string[] = [];
    if (!w.title.trim()) out.push("Add a headline.");
    if (w.title.length > MAX_TITLE) out.push(`Headline is too long (max ${MAX_TITLE} characters).`);
    if (!w.markdown.trim()) out.push("The story is empty.");
    if (new TextEncoder().encode(w.markdown).length > MAX_POST_BYTES) out.push("The story text is too long (max 512 KB).");
    return out;
  }

  /** The posts that will be live after publishing `id` (or after republishing everything as it is now). */
  plan(id?: string, opts: { retract?: string } = {}): Post[] {
    const now = nowIso();
    const out: Post[] = [];
    for (const p of this.posts) {
      if (p.id === id) {
        const w = p.work;
        const post: Post = {
          id: p.id,
          title: w.title.trim(),
          summary: w.summary || summarise(w.markdown),
          kind: w.kind,
          publishedAt: p.live?.publishedAt ?? now,
          updatedAt: now,
          tags: w.tags,
          markdown: w.markdown,
        };
        if (w.image) post.image = w.image;
        // Retracting adds a notice. Publishing the story again (no retract option) deliberately clears it.
        if (opts.retract !== undefined) post.retracted = { at: now, note: opts.retract.trim() || "This story has been retracted." };
        out.push(post);
      } else if (p.live) {
        out.push(p.live);
      }
    }
    return out;
  }

  /** Called only after a publish was confirmed. */
  commit(livePosts: Post[], version: number): void {
    const byId = new Map(livePosts.map((p) => [p.id, p]));
    for (const p of this.posts) {
      const live = byId.get(p.id);
      if (live) p.live = live;
    }
    this.site.version = version;
  }

  siteMeta(): SiteMeta {
    if (!this.site.manifest || !this.site.owner) throw new Error("The permanent link has not been created yet.");
    const meta: SiteMeta = {
      schema: 1,
      title: this.site.title,
      tagline: this.site.tagline,
      about: this.site.about,
      lang: this.site.lang,
      feed: { owner: this.site.owner, topic: this.site.topic, manifest: this.site.manifest },
      createdAt: this.site.createdAt,
    };
    if (this.site.live.enabled) meta.live = { broker: this.site.live.broker, topic: `${this.site.topic}-live` };
    return meta;
  }

  /** Media paths referenced by the given posts, so we only upload images that are actually used. */
  static mediaUsedBy(posts: Post[]): Set<string> {
    const used = new Set<string>();
    const re = /media\/[A-Za-z0-9._-]+/g;
    for (const p of posts) {
      for (const m of p.markdown.matchAll(re)) used.add(m[0]);
      if (p.image) used.add(p.image);
    }
    return used;
  }

  /** Build the exact files that publishing `posts` would upload. */
  async buildFiles(
    posts: Post[],
    getMedia: (path: string) => Promise<Uint8Array | undefined>,
    reader: BundledFile[],
    privateKeyHex: string,
  ) {
    const media = new Map<string, Uint8Array>();
    const missing: string[] = [];
    for (const path of Newsroom.mediaUsedBy(posts)) {
      const bytes = await getMedia(path);
      if (bytes) media.set(path, bytes);
      else missing.push(path);
    }
    if (missing.length) {
      throw new Error(`Some images are missing from this device (${missing.join(", ")}). Remove them from the story or re-add them.`);
    }
    return buildSnapshot({ site: this.siteMeta(), posts, media, reader, previousVersion: this.site.version, privateKeyHex });
  }

  /** Rebuild local state from what is on Swarm (new device, cleared browser, lost laptop). */
  static fromRemote(site: SiteMeta, index: PostsIndex, posts: Post[], keepSettings?: Partial<SiteConfig>): Newsroom {
    const cfg: SiteConfig = {
      title: site.title,
      tagline: site.tagline,
      about: site.about,
      lang: site.lang,
      topic: site.feed.topic,
      manifest: site.feed.manifest,
      owner: site.feed.owner,
      version: index.version,
      createdAt: site.createdAt,
      live: { enabled: !!site.live, broker: site.live?.broker ?? DEFAULT_BROKER },
      ...keepSettings,
    };
    const local = posts
      .filter((p) => isSafeId(p.id))
      .map<LocalPost>((p) => ({
        id: p.id,
        live: p,
        createdAt: p.publishedAt,
        editedAt: p.updatedAt,
        work: { title: p.title, summary: p.summary, kind: p.kind, tags: p.tags, markdown: p.markdown, ...(p.image ? { image: p.image } : {}) },
      }));
    return new Newsroom(cfg, local);
  }

  private must(id: string): LocalPost {
    const p = this.get(id);
    if (!p) throw new Error("Story not found.");
    return p;
  }
}

export const metaOf = (index: PostsIndex): PostMeta[] => index.posts;
