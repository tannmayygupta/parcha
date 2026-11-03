/**
 * Upload the built publisher app (dist/) to Swarm, and give it its own permanent link, so the
 * newsroom's TOOL is as hard to take down as its site. Run `npm run build` first (the npm script
 * `deploy:publisher` does).
 *
 *   BEE_URL=http://localhost:1633 BATCH_ID=<64 hex> PUBLISHER_KEY=<64 hex> npm run deploy:publisher
 *
 * PUBLISHER_KEY signs the app's own feed (a different key from any newsroom). If omitted, a fresh
 * key is generated and printed so you can reuse it for the next deploy. Keep it out of git.
 */
import { Bee, PrivateKey, Topic } from "@ethersphere/bee-js";
import { generateKey } from "../src/publisher/vault";
import { GATEWAYS } from "../src/shared/gateways";

const beeUrl = process.env.BEE_URL ?? "http://localhost:1633";
const batchId = process.env.BATCH_ID;
if (!batchId) throw new Error("Set BATCH_ID to an immutable postage batch.");

const keyHex = process.env.PUBLISHER_KEY ?? generateKey();
if (!process.env.PUBLISHER_KEY) console.log(`Generated a deployer key (save it to update this link later):\n  PUBLISHER_KEY=${keyHex}\n`);

const bee = new Bee(beeUrl);
const key = new PrivateKey(keyHex);
const topic = Topic.fromString("parcha-publisher-app");

console.log("Uploading dist/ …");
const up = await bee.collection.uploadFromDirectory(batchId, "dist", { indexDocument: "index.html" });
const ref = up.reference.toHex();
console.log("snapshot:", ref);

const writer = bee.feed.makeWriter(topic, key);
await writer.uploadReference(batchId, ref);
const manifest = (await bee.feed.createManifest(batchId, topic, key.publicKey().address())).toHex();

console.log("\nPublisher app permanent link (always the latest build):");
console.log(`  bzz://${manifest}`);
for (const g of GATEWAYS) console.log(`  ${g.label.padEnd(24)} ${g.url(manifest)}`);
