/**
 * Postage-stamp helper for a REAL Bee node. Storage is prepaid; this script shows what you have and,
 * only when you pass --yes, spends xBZZ on the node's wallet.
 *
 *   npm run provision -- list
 *   npm run provision -- cost  --size 100MB --days 30
 *   npm run provision -- buy   --size 100MB --days 30 --yes      (creates an IMMUTABLE batch)
 *   npm run provision -- topup --batch <id> --days 30 --yes
 *   npm run provision -- dilute --batch <id> --depth 22 --yes
 *
 * BEE_URL defaults to http://localhost:1633. The gift code is the wallet key of a Bee node: put it in
 * the node's configuration (never in this repo) and point BEE_URL at that node.
 */
import { Bee, Duration, Size } from "@ethersphere/bee-js";
import { formatDuration } from "../src/swarm/stamp-health";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const yes = args.includes("--yes");
const bee = new Bee(process.env.BEE_URL ?? "http://localhost:1633");

function needYes(what: string): void {
  if (!yes) {
    console.log(`\nThis will ${what} using the node's wallet. Re-run with --yes to proceed.`);
    process.exit(0);
  }
}

const size = () => Size.fromMegabytes(Number((flag("size") ?? "100MB").replace(/mb$/i, "")));
const days = () => Duration.fromDays(Number(flag("days") ?? "30"));

switch (cmd) {
  case "list": {
    const all = await bee.stamp.getAll();
    if (!all.length) console.log("No batches on this node.");
    for (const s of all) {
      console.log(
        `${s.batchID.toHex()}  ${s.usable ? "usable " : "pending"}  ${s.immutableFlag ? "immutable" : "MUTABLE (do not use with feeds)"}  depth ${s.depth}  ${s.usageText} used  ${formatDuration(s.duration.toSeconds())} left  ${s.label ?? ""}`,
      );
    }
    break;
  }
  case "cost": {
    const cost = await bee.storage.getCost(size(), days());
    console.log(`${flag("size") ?? "100MB"} for ${flag("days") ?? "30"} days costs about ${cost.toSignificantDigits(4)} xBZZ`);
    break;
  }
  case "buy": {
    const cost = await bee.storage.getCost(size(), days());
    console.log(`Cost: about ${cost.toSignificantDigits(4)} xBZZ for ${flag("size") ?? "100MB"} x ${flag("days") ?? "30"} days (immutable).`);
    needYes("BUY a new storage batch");
    const id = await bee.storage.buy(size(), days(), { label: flag("label") ?? "parcha", immutableFlag: true });
    console.log(`Bought batch: ${id.toHex()}\nIt becomes usable after the chain confirms it (usually 1-2 minutes). Check with: npm run provision -- list`);
    break;
  }
  case "topup": {
    const batch = flag("batch");
    if (!batch) throw new Error("--batch <id> is required");
    const cost = await bee.storage.getDurationExtensionCost(batch, days());
    console.log(`Extending by ${flag("days") ?? "30"} days costs about ${cost.toSignificantDigits(4)} xBZZ`);
    needYes("TOP UP the batch");
    await bee.storage.extendDuration(batch, days());
    console.log("Done.");
    break;
  }
  case "dilute": {
    const batch = flag("batch");
    const depth = Number(flag("depth"));
    if (!batch || !depth) throw new Error("--batch <id> and --depth <n> are required");
    console.log("Diluting increases capacity but shortens the remaining time (top up afterwards).");
    needYes("DILUTE the batch");
    await bee.stamp.dilute(batch, depth);
    console.log("Done.");
    break;
  }
  default:
    console.log("usage: npm run provision -- list | cost | buy | topup | dilute   (see the header of scripts/provision.ts)");
}
