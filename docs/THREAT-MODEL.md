# Threat model

Who might try to stop or abuse a small newsroom, and what Parcha does about each.

| # | Adversary / failure | Attack | Defence | Residual risk |
|---|---|---|---|---|
| 1 | Hosting provider / registrar / payment processor | Suspend server, seize domain | No server and no domain in the path. Link = feed manifest (derived from the newsroom key). Publisher app can be on Swarm too. | None from these parties. |
| 2 | One public gateway | Block or de-list the site | Several independent mirrors listed in the reader and the app; `bzz://`; local-node URL; `npm run verify` shows which doors are open. | A censor can block *all* gateways in a region; readers then need their own node or a Swarm-aware browser. |
| 3 | Gateway operator / network attacker | Serve altered stories | Edition is signed by the newsroom key; per-story hashes pinned in the signed index; reader shows a warning on mismatch. | A malicious gateway can still *withhold* or serve an old edition. |
| 4 | Stale or malicious gateway | Roll the reader back to an old edition | Reader remembers the highest verified version and refuses to go backwards, telling the reader. | First-time visitors have no memory; they see whatever the gateway serves, but it is at least a validly signed edition. |
| 5 | Someone who steals the key | Publish as the newsroom | Key is passphrase-encrypted at rest, memory-only while unlocked, never transmitted. | Compromised device or weak passphrase. No remote revocation exists. Rotating means a new link. |
| 6 | Lost key | Newsroom can't update its link | Mandatory backup acknowledgement before first publish; downloadable keystore; recovery from link + backup. | If both device and backup are lost, the link is frozen (still readable forever, but not updatable). |
| 7 | Hostile story content / XSS | Script in Markdown, tracking pixels | Raw HTML dropped, DOMPurify, only `media/…` images allowed, CSP `script-src 'self'`, links get `noopener noreferrer`. | Browser bugs. |
| 8 | Reader tracking | Learn which readers read what | No third-party requests, `referrer: no-referrer`, no cookies, no analytics. | Gateways and network observers still see requests; use Tor/own node for stronger privacy. |
| 9 | Photo metadata | GPS/EXIF in a photo identifies a source | Every image is re-encoded on a canvas: only pixels survive. | Pixels themselves can identify (faces, landmarks); that is an editorial decision. |
| 10 | Forged "breaking news" alert | Fake pubsub message | Library proves who signed each message; reader accepts only the newsroom's key; and the message is only a hint, content is fetched and verified from the feed. | None for content; a spoofed hint can at most trigger an extra poll. |
| 11 | Broker down / blocked | Live alerts fail | Polling every 45 s; broker is optional and lazily loaded. | Alerts are slower (≤ ~1 min). |
| 12 | Storage runs out | Data dropped by the network | Time/space meter, thresholds (14 d warn, 3 d critical, 70 % / 90 % full), top-up/dilute tooling, preflight blocks publishing into a full batch. | Someone must keep paying. |
| 13 | Mutable stamp batch | Old feed entries overwritten, link breaks | Detected and flagged critical; docs and provisioning script create immutable batches. | A user can ignore the warning. |
| 14 | Newsroom's own mistake | Publish something wrong / dangerous | Explicit permanence confirmation; retraction notice; preview shows exactly what readers get. | Swarm cannot erase. By design. |
| 15 | Browser storage cleared | Lose drafts and key | Restore published content from Swarm; keystore backup. Unpublished drafts are device-local (stated). | Unpublished drafts are lost. |

## Out of scope (stated, not hidden)

- Anonymity of the newsroom against a global network adversary; Swarm uploads are not anonymous by themselves.
- Legal risk of publishing; the tool makes content hard to remove, which is the point, and also a responsibility.
- Rotating a compromised key while keeping the same link. A feed is bound to its owner. A planned extension is a signed "moved to" notice in the final edition.
