# Runbook: first contact with real Swarm

Everything below the Swarm boundary has been tested against `scripts/mock-bee.ts`, which implements the same endpoints but is **not** Swarm. These are the things only the real network can confirm, in the order to check them. Record results in README → *Evidence*.

## 0. Get a Bee node that owns the gift-code wallet

The gift code is the private key of a Gnosis Chain wallet holding xDAI + xBZZ. Bee needs a node with that wallet to buy stamps and upload. Follow the bot's instructions; put the key in the **node's** config (never in this repo, never in chat/screenshots). Then:

```bash
curl http://localhost:1633/health
npm run provision -- list
```

Note: a browser calls the node directly, so the node's API must allow this page's origin (CORS). Browsers also require HTTPS pages to call HTTPS APIs (mixed content): for a gateway-hosted publisher, use an HTTPS node address.

## 1. Stamp

```bash
npm run provision -- cost --size 100MB --days 30
npm run provision -- buy  --size 100MB --days 30 --yes    # immutable
npm run provision -- list                                  # wait until "usable"
```

## 2. Smoke test with the real node

```bash
BEE_URL=http://localhost:1633 BATCH_ID=<id> npm run e2e
```

Things to watch (and what to do if they differ):

| Check | If it fails |
|---|---|
| `POST /bzz` tar upload accepted, returns a reference | Look at header handling in `SwarmClient.uploadSnapshot` |
| `createManifest` then `/bzz/<manifest>/` serves `index.html` | Feed manifest creation / path handling |
| Second publish: same manifest serves *new* content; time until it does | Tune `confirm()` timeout/poll; document lag in UI wording |
| Re-uploading unchanged files does not consume extra stamp capacity | If it does, switch to incremental uploads (reuse `media/*` by reference) |
| `Content-Type` of `.js`/`.css` is correct | Reader would not load; then upload those with explicit types |
| `GET /stamps/<id>` field names match `RawStamp` | Adjust `assessStamp` mapping |

## 3. Gateways and the kill test

```bash
npm run verify -- <manifest> --min-version 2 --bee http://localhost:1633
```

Confirm in a browser: `https://<cid>.bzz.link/`. If the reader loads but shows a CSP error in the console, relax only the failing directive in `src/reader/index.html`. If bzz.link rejects the CID, compare against the encoder in `src/shared/cid.ts` (prefix should be `bah5acgza…`; the official example CID begins that way).

## 4. Pubsub

Open the reader in two tabs, publish an *alert* from the app, and expect the other tab to update within a second or two. Check the console for CSP or WebSocket errors (libp2p). If the default broker is down, readers still update within the 45 s poll: confirm that too.

## 5. Publisher on Swarm

```bash
npm run build
BEE_URL=... BATCH_ID=... npm run deploy:publisher
```

Open the printed link, run the setup, point it at an HTTPS-reachable node, publish once. This is the "nothing of ours is in the loop" demo.
