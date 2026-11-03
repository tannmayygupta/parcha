import { jsonBytes, sha256Hex } from "./bytes";
import { createSeal } from "./seal";
import { PATHS, SCHEMA_VERSION, type Post, type PostMeta, type PostsIndex, type SiteMeta, type SnapshotFile } from "./types";

/** A file bundled with the site (the reader app: html, js, css). */
export interface BundledFile {
  path: string;
  content: string;
}

export interface BuildInput {
  site: SiteMeta;
  /** Only published posts. Order does not matter; the index is sorted newest first. */
  posts: Post[];
  /** Images and other media, keyed by snapshot path (media/<hash>.jpg). */
  media: Map<string, Uint8Array>;
  reader: BundledFile[];
  /** Previous version number (0 for the first publish). */
  previousVersion: number;
  privateKeyHex: string;
  now?: Date;
}

export interface BuildResult {
  files: SnapshotFile[];
  version: number;
  index: PostsIndex;
}

const te = new TextEncoder();

/**
 * Turns the newsroom's state into the exact set of files that will be uploaded to Swarm.
 * Pure and deterministic given its input, so it can be unit-tested without a network.
 *
 * Layout (all paths relative, so it works on any gateway, any subdomain, any base path):
 *   index.html, assets/*          the reader app
 *   data/site.json                title, tagline, feed owner/topic/manifest, live-channel config
 *   data/posts.json               index of posts (newest first) with a hash of each post file
 *   data/posts/<id>.json          one file per post (markdown source)
 *   data/seal.json                publisher signature over posts.json
 *   media/<hash>.<ext>            images
 */
export function buildSnapshot(input: BuildInput): BuildResult {
  const now = (input.now ?? new Date()).toISOString();
  const version = input.previousVersion + 1;

  const files: SnapshotFile[] = [];
  const metas: PostMeta[] = [];

  const sorted = [...input.posts].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
  for (const post of sorted) {
    const bytes = jsonBytes(orderedPost(post));
    files.push({ path: PATHS.post(post.id), bytes });
    const meta: PostMeta = {
      id: post.id,
      title: post.title,
      summary: post.summary,
      kind: post.kind,
      publishedAt: post.publishedAt,
      updatedAt: post.updatedAt,
      tags: post.tags,
      hash: sha256Hex(bytes),
    };
    if (post.image) meta.image = post.image;
    if (post.retracted) meta.retracted = post.retracted;
    metas.push(meta);
  }

  const index: PostsIndex = { version, publishedAt: now, posts: metas };
  const postsBytes = jsonBytes(index);
  const seal = createSeal(input.privateKeyHex, version, now, postsBytes);

  files.push({ path: PATHS.posts, bytes: postsBytes });
  files.push({ path: PATHS.seal, bytes: jsonBytes(seal) });
  files.push({ path: PATHS.site, bytes: jsonBytes({ ...input.site, schema: SCHEMA_VERSION }) });
  for (const [path, bytes] of input.media) files.push({ path, bytes });
  for (const f of input.reader) files.push({ path: f.path, bytes: te.encode(f.content) });

  assertSafePaths(files);
  return { files, version, index };
}

/** Fixed key order so the same post always hashes the same. */
function orderedPost(p: Post): Post {
  const out: Post = {
    id: p.id,
    title: p.title,
    summary: p.summary,
    kind: p.kind,
    publishedAt: p.publishedAt,
    updatedAt: p.updatedAt,
    tags: p.tags,
    markdown: p.markdown,
  };
  if (p.image) out.image = p.image;
  if (p.retracted) out.retracted = p.retracted;
  return out;
}

/** Guard against path tricks and accidental duplicates before anything touches the network. */
export function assertSafePaths(files: SnapshotFile[]): void {
  const seen = new Set<string>();
  for (const f of files) {
    if (!/^[A-Za-z0-9._\-/]+$/.test(f.path) || f.path.includes("..") || f.path.startsWith("/")) {
      throw new Error(`unsafe snapshot path: ${f.path}`);
    }
    if (seen.has(f.path)) throw new Error(`duplicate snapshot path: ${f.path}`);
    seen.add(f.path);
  }
}

export const totalBytes = (files: SnapshotFile[]): number => files.reduce((n, f) => n + f.bytes.length, 0);
