import { type Announcement, encodeAnnouncement } from "../live/protocol";
import type { BundledFile } from "../shared/snapshot";
import { totalBytes } from "../shared/snapshot";
import { nowIso } from "../shared/ids";
import type { Post } from "../shared/types";
import type { PublishProgress, PublishResult, SwarmClient } from "../swarm/client";
import type { StampHealth } from "../swarm/stamp-health";
import { Newsroom } from "./newsroom";

export interface Preflight {
  canPublish: boolean;
  blockers: string[];
  warnings: string[];
  stamp?: StampHealth;
}

/** Everything we can check BEFORE touching the user's content or spending anything. */
export async function preflight(nr: Newsroom, client: SwarmClient): Promise<Preflight> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!nr.site.manifest) blockers.push("The permanent link has not been created yet. Finish setup first.");
  if (!client.cfg.batchId) blockers.push("No storage batch is set. Add one in Settings.");
  const health = await client.health();
  if (!health.ok) {
    blockers.push(`Can't reach the Swarm node (${health.note}). Check Settings and your connection.`);
    return { canPublish: false, blockers, warnings };
  }
  let stamp: StampHealth | undefined;
  try {
    stamp = await client.stamp();
    if (!stamp.usable) blockers.push(stamp.messages[0] ?? "The storage batch is not usable.");
    else if (stamp.usage >= 0.98) blockers.push(stamp.messages[0] ?? "The storage batch is full.");
    else for (const m of stamp.messages) warnings.push(m);
  } catch {
    warnings.push("Couldn't read the storage batch status. Publishing may still work.");
  }
  return { canPublish: blockers.length === 0, blockers, warnings, ...(stamp ? { stamp } : {}) };
}

export interface PublishDeps {
  newsroom: Newsroom;
  client: SwarmClient;
  privateKey: string;
  reader: BundledFile[];
  getMedia: (path: string) => Promise<Uint8Array | undefined>;
  announce?: (a: Announcement) => Promise<{ ok: boolean; note: string }>;
  onProgress?: (p: PublishProgress) => void;
}

export interface PublishOutcome extends PublishResult {
  version: number;
  fileCount: number;
  bytes: number;
  live: { ok: boolean; note: string };
}

/**
 * Publish one story (or, with no id, re-publish the site as it is now).
 * The newsroom's local state only changes AFTER Swarm has accepted the new snapshot and moved the
 * feed, so a failure at any point leaves everything exactly as it was and can simply be retried.
 */
export async function publishStory(deps: PublishDeps, target: { id?: string; retract?: string } = {}): Promise<PublishOutcome> {
  const { newsroom: nr, client } = deps;
  if (target.id) {
    const problems = nr.problems(target.id);
    if (problems.length) throw new Error(problems.join(" "));
  }
  if (!nr.site.manifest) throw new Error("The permanent link has not been created yet.");

  const plan: Post[] = nr.plan(target.id, target.retract !== undefined ? { retract: target.retract } : {});
  const built = await nr.buildFiles(plan, deps.getMedia, deps.reader, deps.privateKey);

  const result = await client.publish(
    built.files,
    { privateKeyHex: deps.privateKey, topic: nr.site.topic, manifest: nr.site.manifest },
    built.version,
    deps.onProgress,
  );

  nr.commit(plan, built.version);

  let live = { ok: false, note: "live updates are off" };
  const story = target.id ? plan.find((p) => p.id === target.id) : undefined;
  if (story && deps.announce && nr.site.live.enabled) {
    live = await deps
      .announce({ t: story.kind === "alert" ? "alert" : "post", v: built.version, id: story.id, title: story.title, ts: nowIso() })
      .catch((e: Error) => ({ ok: false, note: e.message }));
  }
  return { ...result, version: built.version, fileCount: built.files.length, bytes: totalBytes(built.files), live };
}

/** The pubsub half: connect, send one small message, disconnect. Never throws. */
export async function announceLive(
  site: { broker: string; topic: string },
  privateKeyHex: string,
  a: Announcement,
  timeoutMs = 12_000,
): Promise<{ ok: boolean; note: string }> {
  try {
    const { connect } = await import("swarm-pubsub");
    const work = (async () => {
      const broker = await connect(site.broker);
      try {
        const channel = await broker.publish(site.topic, privateKeyHex);
        await channel.send(encodeAnnouncement(a));
        channel.close();
      } finally {
        await broker.close().catch(() => {});
      }
    })();
    await Promise.race([work, new Promise((_, rej) => setTimeout(() => rej(new Error("live broker timed out")), timeoutMs))]);
    return { ok: true, note: "live subscribers were notified" };
  } catch (e) {
    return { ok: false, note: `Live alert not sent (${(e as Error).message}). Readers will still see the story within a minute.` };
  }
}
