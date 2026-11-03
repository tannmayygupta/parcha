/** Data model shared by the publisher app, the reader site and the Node scripts. */

export const SCHEMA_VERSION = 1;

/** Where the permanent link lives. `owner` is lowercase hex without 0x. */
export interface FeedRef {
  owner: string;
  topic: string;
  /** Reference of the feed manifest: `bzz://<manifest>` always resolves to the latest snapshot. */
  manifest: string;
}

export interface LiveConfig {
  /** swarm-pubsub broker multiaddr (browser needs /tls/ws). */
  broker: string;
  /** Channel topic. The channel owner is `feed.owner`. */
  topic: string;
}

export interface SiteMeta {
  schema: number;
  title: string;
  tagline: string;
  about: string;
  /** BCP-47 language tag, e.g. "en", "hi", "ur". Drives <html lang> and text direction. */
  lang: string;
  feed: FeedRef;
  live?: LiveConfig;
  createdAt: string;
}

export type PostKind = "article" | "alert";

export interface PostMeta {
  id: string;
  title: string;
  summary: string;
  kind: PostKind;
  publishedAt: string;
  updatedAt: string;
  tags: string[];
  /** Relative path inside the snapshot, e.g. "media/ab12.jpg". */
  image?: string;
  /** sha256 (hex) of the exact bytes of data/posts/<id>.json */
  hash: string;
  /** Set when the newsroom retracts a story: the text stays on Swarm, readers see a notice. */
  retracted?: { at: string; note: string };
}

/** Full post, stored at data/posts/<id>.json */
export interface Post {
  id: string;
  title: string;
  summary: string;
  kind: PostKind;
  publishedAt: string;
  updatedAt: string;
  tags: string[];
  image?: string;
  markdown: string;
  retracted?: { at: string; note: string };
}

/** data/posts.json */
export interface PostsIndex {
  /** Monotonic counter, +1 on every publish. Readers use it to detect new content. */
  version: number;
  publishedAt: string;
  posts: PostMeta[];
}

/**
 * data/seal.json: the publisher's signature over posts.json.
 * Together with the per-post hashes it makes every copy of the site verifiable, wherever it is mirrored.
 */
export interface Seal {
  schema: number;
  owner: string;
  version: number;
  publishedAt: string;
  postsHash: string;
  /** 65-byte recoverable secp256k1 signature, hex. */
  signature: string;
}

export interface SnapshotFile {
  path: string;
  bytes: Uint8Array;
}

export const PATHS = {
  site: "data/site.json",
  posts: "data/posts.json",
  seal: "data/seal.json",
  post: (id: string) => `data/posts/${id}.json`,
  index: "index.html",
} as const;

/** Default pubsub broker from the swarm-pubsub package (a shared test broker; correctness never depends on it). */
export const DEFAULT_BROKER =
  "/dns4/broker.hiveway.xyz/tcp/443/tls/ws/p2p/QmSjaR7gK8jmVvU6kfH5n2vDj9yjDkN9rXCddtBcDdm844";

/** Size cap for a pubsub announcement; the library limit is 4 KB, stay well under. */
export const MAX_ANNOUNCE_BYTES = 1024;
