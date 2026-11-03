/**
 * The live layer is a HINT, never the record.
 *
 * Swarm pubsub messages are not stored (a reader who is offline misses them) and are capped at
 * 4 KB. So a message only says "version N is out, here is a headline". Readers then fetch the real
 * content from the feed and verify it there. A forged, dropped or missing message can therefore
 * never change what a reader is shown, at worst it delays the refresh until the next poll.
 */
import { MAX_ANNOUNCE_BYTES } from "../shared/types";

export interface Announcement {
  /** "post" for a normal story, "alert" for breaking news. */
  t: "post" | "alert";
  /** Snapshot version this announcement refers to. */
  v: number;
  id: string;
  title: string;
  ts: string;
}

export function encodeAnnouncement(a: Announcement): string {
  let title = a.title.replace(/\s+/g, " ").trim();
  let out = JSON.stringify({ ...a, title });
  // Trim by code points until it fits; titles can be in any script.
  while (new TextEncoder().encode(out).length > MAX_ANNOUNCE_BYTES && title.length > 1) {
    title = Array.from(title).slice(0, Math.max(1, Array.from(title).length - 20)).join("") + "…";
    out = JSON.stringify({ ...a, title });
  }
  return out;
}

/** Defensive parse: anything unexpected is simply ignored. */
export function decodeAnnouncement(text: string): Announcement | null {
  if (text.length > 4096) return null;
  try {
    const j = JSON.parse(text) as Partial<Announcement>;
    if (j.t !== "post" && j.t !== "alert") return null;
    if (!Number.isInteger(j.v) || (j.v as number) < 1) return null;
    if (typeof j.id !== "string" || !/^[a-z0-9]{6,32}$/.test(j.id)) return null;
    if (typeof j.title !== "string" || typeof j.ts !== "string") return null;
    return { t: j.t, v: j.v as number, id: j.id, title: j.title.slice(0, 300), ts: j.ts.slice(0, 40) };
  } catch {
    return null;
  }
}
