# Architecture

## Principles

1. **Swarm is the source of truth.** Local storage is a cache and a working area. Delete the browser and nothing is lost except unpublished drafts.
2. **Nothing the reader needs can be taken away.** No CDN, no analytics, no API. The reader is a static page that only fetches siblings of itself.
3. **Failure never half-applies.** Local state changes only after Swarm confirmed the new snapshot *and* the feed moved. Every earlier failure leaves everything as it was and is safely retryable.
4. **Live is a hint, not a record.** Pubsub can be dropped, delayed, forged or offline. The reader treats it as "go check the feed", and verifies there.
5. **Say what's permanent.** The UI says publishing can't be undone, offers retraction instead of deletion, and strips photo metadata before upload.

## Data model (`src/shared/types.ts`)

A **snapshot** is a complete, self-contained site:

| Path | Content |
|---|---|
| `index.html`, `assets/*` | The reader app |
| `data/site.json` | Title, tagline, language, `feed {owner, topic, manifest}`, optional `live {broker, topic}` |
| `data/posts.json` | `{version, publishedAt, posts[]}` newest first. Each entry carries `hash = sha256(post file bytes)` |
| `data/posts/<id>.json` | One story: Markdown + metadata |
| `data/seal.json` | `{owner, version, publishedAt, postsHash, signature}` secp256k1 over those fields |
| `media/<hash>.jpg` | Re-encoded images |

**Integrity chain:** `seal` signs `posts.json` → `posts.json` pins every story's hash → a story is shown "Verified" only if the seal verifies against the feed owner *and* the story's bytes match its pinned hash. This holds for any copy, from any gateway, mirror, or archive.

**Why full snapshots instead of deltas:** the feed holds one 32-byte reference, so there is nothing to merge or lose; any single snapshot is a complete site; unchanged chunks are already on the network, so re-uploading unchanged files costs little (to be confirmed against real stamps, see RUNBOOK).

## The publish transaction (`src/publisher/publish.ts`, `src/swarm/client.ts`)

```
preflight   node reachable? batch usable, immutable, not full?          → blockers / warnings
plan        working copy of ONE story goes live, other stories keep their live copy
build       snapshot files + hashes + seal (pure function, unit-tested)
upload      one collection → snapshot reference            (retry transient errors)
feed        write next feed index → snapshot reference     (retry transient errors)
confirm     read the permanent link until it serves the new version (poll: gateways cache)
commit      only now: mark story live, bump version, persist
announce    best-effort pubsub hint; failure is reported, never fatal
```

### Why a story has two copies (`src/publisher/newsroom.ts`)

`LocalPost` = `work` (what the journalist is editing) + `live` (what is on Swarm). Publishing story X replaces only X's live copy. Half-edited text in story Y never leaks when X is published. A story with `work ≠ live` shows "Live · unpublished edits".

## Keys (`src/publisher/vault.ts`)

- Generated in the browser (`secp256k1` secure random). Never transmitted.
- At rest: PBKDF2-SHA256 (600k iterations) → AES-256-GCM, address bound as associated data (a keystore can't be relabelled).
- Held in memory only while unlocked.
- One key does three jobs: signs the **feed** (so only the newsroom can move the link), signs the **seal** (so readers can verify content), and signs **pubsub** messages (so only the newsroom can raise alerts).

## Reader behaviour (`src/reader/main.ts`)

- Resolves everything relative to its own URL, so the same files work at `/bzz/<ref>/`, `https://<cid>.bzz.link/`, or a local node.
- `GET` with `cache: no-store` and `credentials: omit`; no cookies, no referrer.
- Poll every 45 s and on tab-focus / reconnect. Live message → immediate poll.
- Verified copies are cached in `localStorage`. If the network fails: show the cache and say so. If a gateway serves an *older* version than the cache: keep the newer cache and say so.
- If opened by raw snapshot reference rather than the permanent link, it says it's a fixed copy and links to the live one.

## Where the real Swarm assumptions live

Everything that talks to Swarm is in `src/swarm/client.ts` (bee-js 13 `collection`, `feed`, plain `fetch` for `/health` and `/stamps`) and `src/shared/gateways.ts`/`cid.ts`. The protocol mock (`scripts/mock-bee.ts`) implements the same endpoints, so a surprise on the real network is isolated to those files.
