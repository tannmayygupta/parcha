/**
 * THE KILL TEST, automated.
 *
 * The challenge's pass/fail question: once our own server and domain are gone, does the link still
 * show the newsroom's latest work? This script asks every independent door into Swarm for the
 * permanent link, checks that each one serves the expected edition, and verifies the publisher's
 * signature on what it got back. None of these requests touch any server of ours.
 *
 *   npm run verify -- <feed-manifest-ref> [--min-version N] [--gateway "https://host/bzz/{ref}/"]... [--json out.json]
 *
 * Exit code 0 only if at least one door served a correctly signed edition at or above --min-version.
 */
import { writeFileSync } from "node:fs";
import { fromUtf8 } from "../src/shared/bytes";
import { isSwarmRef } from "../src/shared/cid";
import { GATEWAYS, type Gateway } from "../src/shared/gateways";
import { verifySeal } from "../src/shared/seal";
import { PATHS, type PostsIndex, type Seal, type SiteMeta } from "../src/shared/types";

export interface DoorResult {
  door: string;
  url: string;
  ok: boolean;
  version?: number;
  signatureValid?: boolean;
  postCount?: number;
  newest?: string;
  ms?: number;
  error?: string;
}

async function get(url: string, timeoutMs: number): Promise<Uint8Array> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "cache-control": "no-cache" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

export async function checkDoor(door: string, base: string, minVersion: number, timeoutMs = 30_000): Promise<DoorResult> {
  const started = Date.now();
  const root = base.endsWith("/") ? base : base + "/";
  try {
    const [postsB, sealB, siteB] = await Promise.all([
      get(root + PATHS.posts, timeoutMs),
      get(root + PATHS.seal, timeoutMs),
      get(root + PATHS.site, timeoutMs),
    ]);
    const idx = JSON.parse(fromUtf8(postsB)) as PostsIndex;
    const site = JSON.parse(fromUtf8(siteB)) as SiteMeta;
    const seal = JSON.parse(fromUtf8(sealB)) as Seal;
    const sig = verifySeal(seal, postsB, site.feed.owner);
    return {
      door,
      url: root,
      ok: idx.version >= minVersion && sig.ok,
      version: idx.version,
      signatureValid: sig.ok,
      postCount: idx.posts.length,
      ...(idx.posts[0] ? { newest: idx.posts[0].title } : {}),
      ms: Date.now() - started,
      ...(sig.ok ? {} : { error: sig.reason }),
      ...(idx.version < minVersion ? { error: `serving version ${idx.version}, expected at least ${minVersion}` } : {}),
    };
  } catch (e) {
    return { door, url: root, ok: false, ms: Date.now() - started, error: (e as Error).message };
  }
}

export async function verifyLink(ref: string, opts: { minVersion?: number; extra?: Gateway[]; beeUrl?: string } = {}): Promise<DoorResult[]> {
  if (!isSwarmRef(ref)) throw new Error("The link must be a 64-character Swarm reference.");
  const doors: { door: string; base: string }[] = [
    ...GATEWAYS.map((g) => ({ door: g.label, base: g.url(ref) })),
    ...(opts.extra ?? []).map((g) => ({ door: g.label, base: g.url(ref) })),
    ...(opts.beeUrl ? [{ door: `node ${opts.beeUrl}`, base: `${opts.beeUrl.replace(/\/+$/, "")}/bzz/${ref}/` }] : []),
  ];
  return Promise.all(doors.map((d) => checkDoor(d.door, d.base, opts.minVersion ?? 1)));
}

export function printTable(results: DoorResult[]): void {
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    const detail = r.ok
      ? `version ${r.version}, ${r.postCount} stories, newest "${r.newest ?? "-"}", signature ${r.signatureValid ? "valid" : "INVALID"}, ${r.ms} ms`
      : r.error ?? "unknown error";
    console.log(`${mark}  ${r.door.padEnd(24)} ${detail}`);
  }
}

// CLI
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const ref = args.find((a) => !a.startsWith("--") && isSwarmRef(a));
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!ref) {
    console.error('usage: npm run verify -- <64-hex feed manifest> [--min-version N] [--bee http://localhost:1633] [--gateway "https://host/bzz/{ref}/"] [--json out.json]');
    process.exit(2);
  }
  const extra: Gateway[] = args.flatMap((a, i) =>
    a === "--gateway" && args[i + 1] ? [{ id: `custom${i}`, label: new URL(args[i + 1]!.replace("{ref}", ref)).host, url: (r: string) => args[i + 1]!.replace("{ref}", r) }] : [],
  );
  const beeUrl = flag("--bee");
  const minVersion = Number(flag("--min-version") ?? 1);
  console.log(`Permanent link: bzz://${ref}\nAsking each door for the latest edition (min version ${minVersion})…\n`);
  const results = await verifyLink(ref, { minVersion, extra, ...(beeUrl ? { beeUrl } : {}) });
  printTable(results);
  const json = flag("--json");
  if (json) writeFileSync(json, JSON.stringify({ ref, checkedAt: new Date().toISOString(), minVersion, results }, null, 2));
  const pass = results.some((r) => r.ok);
  console.log(`\n${pass ? "RESULT: the link serves a correctly signed latest edition without any server of ours." : "RESULT: NO door served a valid latest edition."}`);
  process.exit(pass ? 0 : 1);
}
