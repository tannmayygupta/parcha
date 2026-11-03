# Flow charts

Every diagram here matches the code. File names point to where each step lives. GitHub renders these diagrams directly.

1. [System overview](#1-system-overview)
2. [Publishing a story](#2-publishing-a-story)
3. [What happens when publishing fails](#3-what-happens-when-publishing-fails)
4. [What a reader's browser does](#4-what-a-readers-browser-does)
5. [How readers know a story is genuine](#5-how-readers-know-a-story-is-genuine)
6. [The live layer (pubsub)](#6-the-live-layer-pubsub)
7. [Storage health (postage stamps)](#7-storage-health-postage-stamps)
8. [Key lifecycle](#8-key-lifecycle)
9. [Story lifecycle](#9-story-lifecycle)
10. [Recovery on a new device](#10-recovery-on-a-new-device)
11. [Photo pipeline](#11-photo-pipeline)
12. [The kill test](#12-the-kill-test)

---

## 1. System overview

Who talks to what. Notice that there is no box labelled "our server".

```mermaid
flowchart LR
  subgraph Journalist["Journalist's device"]
    APP["Publisher app<br/>static page"]
    KEY[("Key, encrypted<br/>with passphrase")]
    DRAFTS[("Drafts and images<br/>this device only")]
  end

  subgraph Swarm["Swarm network"]
    NODE["Bee node or<br/>upload gateway"]
    CHUNKS[("Chunks spread over<br/>many independent nodes")]
    FEED["Feed<br/>moves to the newest edition"]
  end

  subgraph Doors["Independent doors for readers"]
    G1["bzz.link"]
    G2["gateway.ethswarm.org"]
    G3["bzz:// or own Bee node"]
  end

  BROKER["Pubsub broker<br/>optional, hint only"]
  READER["Reader's browser<br/>runs the reader page"]

  APP --- KEY
  APP --- DRAFTS
  APP -->|"1. upload edition<br/>2. move feed"| NODE
  NODE --> CHUNKS
  NODE --> FEED
  APP -.->|"3. small signed hint"| BROKER
  BROKER -.->|"new edition is out"| READER
  CHUNKS --> G1
  CHUNKS --> G2
  CHUNKS --> G3
  FEED --> G1
  FEED --> G2
  FEED --> G3
  G1 --> READER
  G2 --> READER
  G3 --> READER
```

---

## 2. Publishing a story

Code: `src/publisher/publish.ts`, `src/swarm/client.ts`, `src/shared/snapshot.ts`.

```mermaid
sequenceDiagram
  autonumber
  actor J as Journalist
  participant A as Publisher app
  participant N as Swarm node
  participant S as Swarm network
  participant B as Pubsub broker
  actor R as Readers with the page open

  J->>A: Click Publish
  A->>N: Preflight: health and stamp status
  N-->>A: Reachable, batch usable and immutable, space left
  A->>A: Show permanence warning and key-backup check
  J->>A: Tick the boxes, confirm
  A->>A: Plan: this story goes live, other stories keep their live copy
  A->>A: Build snapshot files, hash every story, sign the seal
  A->>N: Upload snapshot as one collection
  N->>S: Store chunks, stamped by the batch
  N-->>A: Snapshot reference
  A->>N: Write next feed index pointing to the snapshot, signed by the key
  N->>S: Store feed update
  loop up to 45 seconds
    A->>N: Read the permanent link
    N-->>A: Version served
  end
  A->>A: Commit: mark story live, bump version, save locally
  A-)B: Announce version and headline, under 1 KB, signed
  B-)R: Hint: version N is out
  R->>N: Fetch and verify the real content
  A-->>J: Published, link now shows version N
```

---

## 3. What happens when publishing fails

The rule: **local state changes only after Swarm confirmed everything**, so a failure at any step is safe to retry. Code: `src/swarm/retry.ts`, `src/swarm/errors.ts`.

```mermaid
flowchart TD
  START["Publish clicked"] --> PRE{"Preflight ok?"}
  PRE -- "node unreachable, batch missing,<br/>expired or 98 percent full" --> BLOCK["Blocked with a plain message.<br/>Nothing was sent."]
  PRE -- yes --> BUILD{"All images present<br/>on this device?"}
  BUILD -- no --> MISSING["Error naming the missing images.<br/>Nothing was sent."]
  BUILD -- yes --> UP["Upload snapshot"]
  UP --> UPOK{"Succeeded?"}
  UPOK -- "temporary: network, 5xx, 429" --> RETRY["Wait 0.8 s, 1.6 s, 3.2 s<br/>then retry, up to 4 tries"]
  RETRY --> UP
  UPOK -- "permanent: batch full, expired,<br/>refused, too large" --> EXPLAIN["Friendly explanation and advice.<br/>Local state untouched."]
  UPOK -- yes --> FEED["Move feed to the new snapshot"]
  FEED --> FEEDOK{"Succeeded?"}
  FEEDOK -- temporary --> RETRYF["Retry with backoff"]
  RETRYF --> FEED
  FEEDOK -- permanent --> EXPLAIN
  FEEDOK -- yes --> CONF["Poll the permanent link"]
  CONF --> SEEN{"Serves the new version<br/>within 45 s?"}
  SEEN -- yes --> OK["Published and confirmed"]
  SEEN -- no --> LATE["Published. Link still catching up.<br/>Message says so honestly."]
  OK --> COMMIT["Commit local state"]
  LATE --> COMMIT
  EXPLAIN --> SAFE["Story is still on this device.<br/>Press Publish again any time."]
  BLOCK --> SAFE
  MISSING --> SAFE
```

---

## 4. What a reader's browser does

Code: `src/reader/main.ts`, `src/reader/live.ts`. Every request is relative to the page's own address, so the same files work on any gateway.

```mermaid
flowchart TD
  OPEN["Reader opens the permanent link"] --> SLASH{"Address ends<br/>without slash?"}
  SLASH -- yes --> FIX["Redirect to add the slash"] --> OPEN
  SLASH -- no --> FETCH["Fetch site.json, posts.json, seal.json<br/>no cookies, no cache"]
  FETCH --> NET{"Fetch worked?"}
  NET -- no --> CACHED{"Verified copy<br/>saved earlier?"}
  CACHED -- yes --> OFFLINE["Show saved copy<br/>with an offline notice"]
  CACHED -- no --> FATAL["Clear message:<br/>can't load, try another mirror"]
  NET -- yes --> VERIFY["Verify the signature<br/>against the feed owner"]
  VERIFY --> OLDER{"Older than a version<br/>already seen here?"}
  OLDER -- yes --> KEEP["Keep the newer saved copy<br/>and explain a gateway is stale"]
  OLDER -- no --> SHOW["Render stories<br/>save verified copy"]
  VERIFY -. "signature fails" .-> WARN["Warning banner:<br/>could not verify this copy"]
  WARN --> SHOW
  SHOW --> BG["Background"]
  KEEP --> BG
  OFFLINE --> BG
  BG --> POLL["Poll every 45 s,<br/>on tab focus, and on reconnect"]
  BG --> LIVE{"Live channel<br/>configured?"}
  LIVE -- yes --> SUB["Lazy-load pubsub and subscribe.<br/>Accept only the newsroom's key."]
  SUB -->|"hint received"| POLL
  LIVE -- no --> POLL
  POLL --> NEWER{"Higher version<br/>and verified?"}
  NEWER -- yes --> UPDATE["Re-render and show a toast"]
  NEWER -- no --> WAIT["Keep waiting"]
```

---

## 5. How readers know a story is genuine

Code: `src/shared/seal.ts`, `src/shared/snapshot.ts`. One signature protects the whole edition, and each story is pinned by a hash.

```mermaid
flowchart LR
  KEY["Newsroom key"] -->|"signs"| SEAL["seal.json<br/>owner, version, time,<br/>hash of posts.json, signature"]
  SEAL -->|"covers"| POSTS["posts.json<br/>list of stories,<br/>each with a hash"]
  POSTS -->|"pins hash of"| S1["posts/story-1.json"]
  POSTS -->|"pins hash of"| S2["posts/story-2.json"]
  SITE["site.json<br/>names the feed owner"] -->|"expected signer"| CHECK
  SEAL --> CHECK{"Reader checks"}
  POSTS --> CHECK
  S1 --> CHECK
  CHECK --> R1["1. Signature recovers to the feed owner?"]
  CHECK --> R2["2. posts.json matches the signed hash?"]
  CHECK --> R3["3. Story bytes match the pinned hash?"]
  R1 --> OUT{"All three pass?"}
  R2 --> OUT
  R3 --> OUT
  OUT -- yes --> GOOD["Story shows Verified"]
  OUT -- no --> BAD["Story shows a warning,<br/>advice to compare with another mirror"]
```

---

## 6. The live layer (pubsub)

Pubsub messages are not stored and are capped at 4 KB. So they are only a nudge. Code: `src/live/protocol.ts`, `src/reader/live.ts`, `announceLive` in `src/publisher/publish.ts`.

```mermaid
sequenceDiagram
  participant P as Publisher app
  participant B as Broker
  participant R as Reader page
  participant F as Feed on Swarm

  Note over R: Page loads and shows the latest edition from Swarm
  R->>B: Subscribe to the channel owned by the newsroom key
  P->>F: Publish edition N, move the feed
  P->>B: Send hint, under 1 KB: version N, id, headline
  B-->>R: Deliver hint, signed by the newsroom key
  R->>R: Ignore unless signer is the newsroom and N is newer
  R->>F: Fetch real content for version N
  R->>R: Verify signature, then render and show a toast

  Note over R,F: If the broker is down, blocked or the message is lost,<br/>the 45 second poll finds version N anyway.
```

---

## 7. Storage health (postage stamps)

Code: `src/swarm/stamp-health.ts`. Swarm keeps data only while its stamp is alive, so the app always shows what is left.

```mermaid
flowchart TD
  S["Read the batch status<br/>GET /stamps/id"] --> EX{"Exists and<br/>not expired?"}
  EX -- no --> C1["CRITICAL: expired or missing.<br/>Buy a new batch and republish.<br/>Publishing blocked."]
  EX -- yes --> US{"Usable?"}
  US -- "no, new batch" --> W1["WARN: wait a minute or two<br/>for on-chain confirmation.<br/>Publishing blocked."]
  US -- yes --> IM{"Immutable?"}
  IM -- no --> C2["CRITICAL: mutable batch can overwrite<br/>old feed entries and break the link"]
  IM -- yes --> FULL{"Fullest bucket usage"}
  C2 --> FULL
  FULL -- "90 percent or more" --> C3["CRITICAL: dilute or buy bigger"]
  FULL -- "70 to 90 percent" --> W2["WARN: plan to dilute"]
  FULL -- "98 percent or more" --> BLK["Publishing blocked"]
  FULL -- "under 70 percent" --> TTL
  C3 --> TTL
  W2 --> TTL
  TTL{"Time left"} -- "3 days or less" --> C4["CRITICAL: top up now"]
  TTL -- "3 to 14 days" --> W3["WARN: top up soon"]
  TTL -- "more than 14 days" --> OK["Healthy"]
```

Why bucket usage: a batch is full when its single fullest bucket is full, long before its nominal size is reached.

---

## 8. Key lifecycle

Code: `src/publisher/vault.ts`. The key is the only thing that can move the permanent link.

```mermaid
stateDiagram-v2
  [*] --> Generated: Setup, secure random in the browser
  Generated --> Encrypted: Passphrase, PBKDF2 600k then AES-256-GCM
  Encrypted --> StoredLocked: Saved in browser storage
  StoredLocked --> Unlocked: Correct passphrase, key held in memory only
  Unlocked --> StoredLocked: Lock, or tab closed
  Encrypted --> BackedUp: Download keystore file
  BackedUp --> StoredLocked
  StoredLocked --> Restored: New device, import backup plus passphrase
  Restored --> StoredLocked
  note right of Unlocked
    Signs: feed updates,
    the edition seal,
    live hints.
    Never leaves the device.
  end note
```

---

## 9. Story lifecycle

Code: `statusOf` in `src/publisher/newsroom.ts`. Each story keeps a private working copy and a live copy, so unfinished edits never leak when another story is published.

```mermaid
stateDiagram-v2
  [*] --> Draft: New story
  Draft --> Draft: Edit, autosaved on device
  Draft --> Live: Publish
  Draft --> [*]: Delete draft
  Live --> LiveWithEdits: Edit the working copy
  LiveWithEdits --> LiveWithEdits: More edits, readers still see the live copy
  LiveWithEdits --> Live: Publish update
  Live --> Retracted: Retract with a note
  LiveWithEdits --> Retracted: Retract with a note
  Retracted --> Live: Publish again
  note right of Retracted
    Swarm cannot delete.
    Readers see a retraction notice,
    the original text stays on Swarm.
  end note
```

---

## 10. Recovery on a new device

Code: `src/publisher/restore.ts`. There is no database: the newsroom's data lives on Swarm.

```mermaid
flowchart TD
  NEW["New laptop or cleared browser"] --> IN["Enter: permanent link,<br/>key backup file and passphrase,<br/>node address, batch id"]
  IN --> KEYOK{"Passphrase opens the backup?"}
  KEYOK -- no --> E1["Clear error, try again"]
  KEYOK -- yes --> GET["Download site.json, posts.json,<br/>seal.json from the link"]
  GET --> OWN{"Site owner equals<br/>the unlocked key's address?"}
  OWN -- no --> E2["Refuse: this site belongs to another key"]
  OWN -- yes --> SIG["Verify seal, warn if it fails"]
  SIG --> ST["Download every story"]
  ST --> MEDIA["Download every image in use"]
  MEDIA --> REBUILD["Rebuild the newsroom:<br/>each story live and in sync"]
  REBUILD --> DONE["Keep publishing on top,<br/>same link, next version"]
```

---

## 11. Photo pipeline

Code: `src/publisher/images.ts`. Photos carry GPS position, device serial numbers and times; re-drawing keeps only the pixels.

```mermaid
flowchart LR
  F["Photo from camera or clipboard"] --> T{"Is an image<br/>and 30 MB or less?"}
  T -- no --> X["Rejected with a clear message"]
  T -- yes --> D["Decode and apply<br/>camera rotation"]
  D --> R["Scale so the longest side<br/>is at most 1600 px"]
  R --> C["Draw on a canvas<br/>only pixels survive"]
  C --> J["Encode as JPEG, quality 0.82"]
  J --> H["Name by content hash<br/>media/hash.jpg"]
  H --> S["Store on this device"]
  S --> U["Uploaded only if a live<br/>story uses it"]
  C -.-> M["GPS, camera model,<br/>timestamps: gone"]
```

---

## 12. The kill test

Code: `scripts/verify-link.ts`, protocol in [KILL-TEST.md](KILL-TEST.md).

```mermaid
flowchart TD
  P1["Publish edition N"] --> REMOVE["Remove everything of ours:<br/>stop dev server, close the app,<br/>clear local storage"]
  REMOVE --> OTHER["On a different device or network,<br/>open the permanent link"]
  OTHER --> SEE1{"Shows edition N,<br/>stories say Verified?"}
  SEE1 -- no --> FAIL["FAIL: something of ours was in the path"]
  SEE1 -- yes --> RESTORE["Restore app from link plus key backup,<br/>publish edition N plus 1"]
  RESTORE --> SAME["Reload the same link"]
  SAME --> SEE2{"Shows edition N plus 1<br/>with the same link?"}
  SEE2 -- no --> FAIL
  SEE2 -- yes --> AUTO["Run: npm run verify"]
  AUTO --> DOORS["Ask each door:<br/>bzz.link, ethswarm gateway,<br/>own node"]
  DOORS --> PASS["PASS: at least one door serves<br/>a correctly signed latest edition"]
```
