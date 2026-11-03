# Parcha

**A newsroom that can't be switched off.**
Write stories, publish them to [Swarm](https://www.ethswarm.org), and give readers **one link that always shows the latest edition**, even after the newsroom's own server and domain are gone.

> Built for Devcon 8 · Build Battle 1: Censorship-Free World.

Parcha (पर्चा) is the Hindi/Urdu word for the leaflet: the cheap, hand-passed sheet that news travels on when the press is closed.

---

## The problem it solves

Small newsrooms, tenants' unions and community archives get taken down by hosting suspensions, domain seizures, payment-processor bans and takedown notices. Every one of those pressure points is a *company* that can be asked to switch something off.

Parcha removes the company from the path:

| What usually gets taken down | What Parcha does instead |
|---|---|
| The web server | The site is a set of files stored across many independent Swarm nodes. There is no host to suspend. |
| The domain name | The link is a **Swarm feed manifest**: a fixed address derived from the newsroom's key, not from a registrar. |
| The CMS / admin panel | The publisher app is a static page too. It can live on Swarm, and it talks straight to a Swarm node. |
| A "single file to lock" | Content is split into chunks and spread over the network. |

## The test, and how this passes it

> *Once your own server and domain are gone, that link still shows their latest work.*

1. The link is `bzz://<feed manifest>`. A feed manifest resolves, on every Swarm gateway and node, to **whatever the newsroom's key last pointed the feed at**.
2. Publishing = upload a complete new snapshot of the site, then move the feed to it. The link never changes; its content does.
3. Nothing in the reader depends on us. It is a static page with relative URLs, no third-party requests, no API of ours.
4. `npm run verify -- <link>` is the kill test, automated: it asks each independent door into Swarm for the latest edition and checks the publisher's signature on the answer. See [docs/KILL-TEST.md](docs/KILL-TEST.md).

## What's in the box

**For the journalist** (`src/publisher`)
- Guided setup: name, key, storage, permanent link. Plain-language errors throughout.
- Editor with live preview, Markdown, breaking-news alerts, autosave on the device.
- **Photos are stripped of GPS and camera data** and compressed before they ever leave the device.
- Publish dialog states plainly that **publishing is permanent**; mistakes are handled with **retractions** (notice + original stays visible), not fake deletes.
- **Storage health** is always visible: time left, space left, and a hard warning for mutable batches (they can break feeds).
- Key protected by a passphrase (PBKDF2-SHA256 → AES-256-GCM), with a downloadable backup, and publishing is gated on acknowledging that backup.
- **Full recovery with no database:** new device + link + key backup restores every story and image *from Swarm itself*.
- Live alerts to readers via `swarm-pubsub`, with a safe fallback when the broker is unavailable.

**For the reader** (`src/reader`): lives *inside* every snapshot
- Works through any gateway, subdomain or local node (all URLs relative).
- Every edition is **signed**; stories show "Verified", tampering shows a warning (see [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)).
- Polls for new editions; with live updates on, new stories appear instantly.
- Keeps a verified offline copy, and **never goes backwards**: a stale gateway can't hide an edition you've already seen.
- Mirror list (bzz.link, gateway.ethswarm.org, `bzz://`, your own node) so a blocked gateway is a shrug, not an outage.
- Zero third-party requests, strict CSP, sanitised Markdown, RTL and Indic-script friendly.

## Architecture in one picture

```
 Journalist's browser (static app, can itself live on Swarm)
   key (encrypted)  ·  drafts + images (this device only)
        │  Publish
        ▼
   build snapshot ──────────────────────────────────────────────────────────┐
   index.html, assets/*     the reader                                      │
   data/site.json           title, feed owner/topic/manifest, live channel   │
   data/posts.json          index, newest first, hash of every story         │
   data/posts/<id>.json     one file per story (Markdown)                    │
   data/seal.json           publisher's signature over posts.json            │
   media/<hash>.jpg         images (metadata-free)                           │
        │                                                                   │
        ▼  1. upload as one collection        ──▶  Swarm (stamped batch)    │
           2. move FEED to the new snapshot   ──▶  Swarm  (signed by key)   │
           3. read the link back, confirm     ◀──  gateway / node            │
           4. announce on pubsub (hint only)  ──▶  readers with the page open│
                                                                            │
 Reader opens  bzz://<feed manifest>/   ◀── always the latest snapshot ─────┘
```

Deeper: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Swarm features used, and why

| Feature | Used for |
|---|---|
| **Collections (`/bzz`)** | Each edition is one atomic upload; either all of it is there or none. |
| **Feeds + feed manifest** | The one permanent link that always resolves to the latest edition. |
| **Postage stamps** | Storage is prepaid. We require *immutable* batches, show time/space left, and explain top-up/dilute. |
| **swarm-pubsub** | The *live layer only*: "version N is out". Messages are 1 KB, signed by the newsroom key, and treated as a hint: readers always re-fetch and verify from the feed. |
| **bzz.link / gateways** | Zero-install reading, via several independent gateways. |

### Design rules that came out of the docs

- Feeds need an **immutable** batch: on a mutable one, a full batch overwrites old chunks and can break feed lookups. Parcha flags mutable batches as critical.
- A batch is full when its **fullest bucket** is full, not when nominal size is reached, so the health meter uses bucket utilisation.
- Pubsub messages are **not stored** and capped at 4 KB. So the feed is the record; pubsub only nudges. A dropped, forged or missing message can never change what a reader sees.
- A 64-hex Swarm reference exceeds the 63-char DNS label limit, so bzz.link URLs use a base32 **CID** (`src/shared/cid.ts`).

## Run it

```bash
npm install
npm test                 # 53 tests: protocol, security, recovery, failure modes
npm run e2e              # whole product, headless, against the built-in mock node
npm run mock-bee         # a local fake Bee on :1633 for developing the UI offline
npm run dev              # publisher app with hot reload
npm run build            # production build of reader + publisher (static files, relative URLs)
```

Against **real Swarm** (needs a Bee node with a funded wallet; see [docs/RUNBOOK.md](docs/RUNBOOK.md)):

```bash
npm run provision -- list                              # your postage batches
npm run provision -- buy --size 100MB --days 30 --yes  # immutable batch
BEE_URL=http://localhost:1633 BATCH_ID=<id> npm run e2e
npm run verify -- <feed manifest> --min-version 2       # the kill test, across gateways
BEE_URL=... BATCH_ID=... npm run deploy:publisher       # put the publisher app itself on Swarm
```

> **Secrets:** the Swarm gift code is a wallet private key. It belongs in your Bee node's configuration, never in this repo. `.env`, keystores and keys are git-ignored.

## Honest status

| | Verified how |
|---|---|
| Snapshot building, signing, tamper detection | Unit tests |
| Publish → feed → link serves latest; retries; lag; failure leaves state untouched | Integration tests against a protocol-level mock Bee, driving the real `bee-js` client |
| Reader rendering, sanitising, verified seal, offline fallback, no-regress | jsdom tests against the mock |
| Stamp health + error explanations | Unit tests |
| Recovery from link + key | Integration test |
| **Real Swarm network, real gateways, real pubsub broker** | See *Evidence* below; filled in from live runs |

### Evidence from the live network

_To be filled in from the live run: feed manifest, per-gateway output of `npm run verify`, and the date._

## Project layout

```
src/shared      data model, signing, snapshot builder, safe Markdown, gateways, CID   (used by everything)
src/swarm       Bee client, stamp health, error explanations, retry
src/publisher   journalist app: vault, newsroom state, publish/restore, UI
src/reader      the site readers see (packed into every snapshot)
src/live        pubsub announcement protocol
scripts         mock-bee, e2e, verify-link (kill test), provision, deploy-publisher
test            unit + integration + reader tests
docs            architecture, threat model, kill test, runbook
```

## Who it's for

> **[Newsroom name]** — _[one paragraph: who they are, what keeps getting taken down, what they publish to tonight. See docs/PERSONA.md.]_

## Limits we state openly

- **Swarm can't delete.** That is the point, and also why we ship retractions and a permanence warning instead of a delete button.
- **Storage is prepaid.** If the batch expires, the network may drop the data. Parcha makes that visible and gives the top-up path, but someone has to pay.
- **Whoever holds the key owns the newsroom.** There is no recovery without the backup. We say so at every step.
- `swarm-pubsub` is v0.1.x. It is deliberately optional here.
- Gateways can block *themselves*; they can't block the network. Hence several mirrors, `bzz://` and local-node links.

## License

MIT
