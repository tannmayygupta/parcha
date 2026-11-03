import { fromUtf8 } from "../shared/bytes";
import { isSafeId } from "../shared/ids";
import { Newsroom } from "./newsroom";
import { verifySeal } from "../shared/seal";
import { PATHS, type Post, type PostsIndex, type Seal, type SiteMeta } from "../shared/types";
import type { SwarmClient } from "../swarm/client";

export interface Restored {
  newsroom: Newsroom;
  media: Map<string, Uint8Array>;
  warnings: string[];
}

/**
 * Rebuild everything from the permanent link. This is what makes "no database" true: the
 * newsroom's data lives on Swarm, so a new laptop plus the key is a full recovery.
 */
export async function restoreFromLink(client: SwarmClient, manifest: string, expectedOwner?: string): Promise<Restored> {
  const warnings: string[] = [];
  const site = JSON.parse(fromUtf8(await client.fetchFile(manifest, PATHS.site))) as SiteMeta;
  const postsBytes = await client.fetchFile(manifest, PATHS.posts);
  const index = JSON.parse(fromUtf8(postsBytes)) as PostsIndex;

  if (site.feed.manifest !== manifest) throw new Error("This link belongs to a different site (manifest mismatch).");
  if (expectedOwner && site.feed.owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error("This site belongs to a different key than the one you unlocked, so you can't publish to it.");
  }
  try {
    const seal = JSON.parse(fromUtf8(await client.fetchFile(manifest, PATHS.seal))) as Seal;
    const res = verifySeal(seal, postsBytes, site.feed.owner);
    if (!res.ok) warnings.push(`Signature check failed: ${res.reason}`);
  } catch {
    warnings.push("No signature found on this copy.");
  }

  const posts: Post[] = [];
  for (const meta of index.posts) {
    if (!isSafeId(meta.id)) {
      warnings.push(`Skipped a story with an unsafe id.`);
      continue;
    }
    try {
      posts.push(JSON.parse(fromUtf8(await client.fetchFile(manifest, PATHS.post(meta.id)))) as Post);
    } catch {
      warnings.push(`Couldn't download the story "${meta.title}".`);
    }
  }

  const media = new Map<string, Uint8Array>();
  for (const path of Newsroom.mediaUsedBy(posts)) {
    try {
      media.set(path, await client.fetchFile(manifest, path));
    } catch {
      warnings.push(`Couldn't download image ${path}.`);
    }
  }
  return { newsroom: Newsroom.fromRemote(site, index, posts), media, warnings };
}
