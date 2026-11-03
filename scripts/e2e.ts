/**
 * End-to-end smoke test of the whole product, headless.
 *
 *   npm run e2e                 against the built-in mock node (offline, no cost)
 *   BEE_URL=http://localhost:1633 BATCH_ID=<64 hex> npm run e2e     against a REAL Bee node / real Swarm
 *
 * It creates a throw-away publisher key, makes the permanent link, publishes two editions, reads the
 * link back through the node and verifies the signature. Against a real node it then prints the
 * public gateway URLs so you can run the kill test (scripts/verify-link.ts) from anywhere.
 */
import { READER_FILES } from "../src/generated/reader-files";
import { Newsroom, defaultSite } from "../src/publisher/newsroom";
import { preflight, publishStory } from "../src/publisher/publish";
import { generateKey } from "../src/publisher/vault";
import { GATEWAYS, nativeUrl } from "../src/shared/gateways";
import { addressOf } from "../src/shared/seal";
import { SwarmClient } from "../src/swarm/client";
import { startMockBee } from "./mock-bee";
import { checkDoor } from "./verify-link";

const real = !!process.env.BEE_URL;
const mock = real ? null : await startMockBee();
const beeUrl = process.env.BEE_URL ?? mock!.url;
const batchId = process.env.BATCH_ID ?? mock!.batchId;

const step = (s: string) => console.log(`\n== ${s}`);
const client = new SwarmClient({ beeUrl, batchId });
const key = generateKey();

try {
  step(`node: ${beeUrl} ${real ? "(REAL)" : "(mock)"}`);
  const nr = new Newsroom(defaultSite("e2e Newsroom"));
  nr.site.owner = addressOf(key);
  nr.site.live.enabled = false; // the live layer is exercised separately; e2e must not depend on a broker

  step("preflight");
  nr.site.manifest = real ? undefined : "x".repeat(64); // preflight only needs *a* manifest
  const pf = await preflight(nr, client);
  console.log(JSON.stringify({ canPublish: pf.canPublish, blockers: pf.blockers, warnings: pf.warnings }, null, 2));
  if (!pf.canPublish && real) throw new Error("preflight failed: " + pf.blockers.join("; "));

  step("create permanent link (feed manifest)");
  nr.site.manifest = await client.ensureManifest(key, nr.site.topic);
  console.log("manifest:", nr.site.manifest);

  const deps = { newsroom: nr, client, privateKey: key, reader: READER_FILES, getMedia: async () => undefined, onProgress: (p: { message: string }) => console.log("  ·", p.message) };

  step("publish edition 1");
  const a = nr.newDraft();
  nr.edit(a.id, { title: "First story", markdown: "This is the first edition." });
  const r1 = await publishStory(deps, { id: a.id });
  console.log(`version ${r1.version}, snapshot ${r1.snapshotRef}, feed index ${r1.feedIndex}, confirmed=${r1.confirmed}`);

  step("publish edition 2 (same link must now show it)");
  const b = nr.newDraft("alert");
  nr.edit(b.id, { title: "Breaking: second edition", markdown: "The link did not change." });
  const r2 = await publishStory(deps, { id: b.id });
  console.log(`version ${r2.version}, snapshot ${r2.snapshotRef}, confirmed=${r2.confirmed}`);

  step("read the permanent link back and verify the signature");
  const door = await checkDoor("node", `${beeUrl}/bzz/${nr.site.manifest}/`, 2);
  console.log(door);
  if (!door.ok) throw new Error("link does not serve the latest signed edition: " + door.error);

  console.log(`\nPASS: one link, two editions, latest served, signature valid.`);
  console.log(`\nPermanent link: ${nativeUrl(nr.site.manifest)}`);
  for (const g of GATEWAYS) console.log(`  ${g.label.padEnd(24)} ${g.url(nr.site.manifest)}`);
  if (real) console.log(`\nNow run the kill test from anywhere:\n  npm run verify -- ${nr.site.manifest} --min-version 2`);
} catch (e) {
  console.error("\nFAIL:", (e as Error).message);
  process.exitCode = 1;
} finally {
  await mock?.close();
}
