# Who Parcha is built for

## The archetype

A **small independent newsroom**: two to ten people, a regional focus, no IT staff, a shoestring budget.

- Their website sits on one host, their domain with one registrar, their money with one payment processor. Any one of those can end the publication overnight.
- They report, often in regional languages, on stories powerful people want gone.
- Sources send them photos. What is hidden inside the file (GPS position, camera serial number, time) can put a source in danger.
- When news breaks, readers must see it in seconds, on phones and slow connections.
- Nobody on the team can run servers.

## How Parcha maps to it

| Their situation | Where it is in the product |
|---|---|
| Host, domain or payments can be pulled | No server or domain in the path. Link is a Swarm feed manifest. The publisher app itself can live on Swarm (`npm run deploy:publisher`) |
| Publish in Hindi, Urdu, Tamil and other languages | Language setting, right-to-left support, Indic-friendly font stacks, Unicode-safe summaries |
| Protect sources | Photo metadata removed on the device before upload. No analytics, no third-party requests, no cookies |
| Breaking news must reach readers fast | Breaking-alert story type, pinned banner for 24 hours, pubsub live updates, 45 s polling fallback |
| Phones and slow connections | Responsive layout, images capped at 1600 px, offline copy of the last verified edition |
| No technical staff | Guided setup, plain-language errors, one permanent link, one-step restore |
| Readers must trust what they see | Every edition is signed, stories show Verified, tampering shows a warning |
| Mistakes happen | Retractions with a visible notice, since nothing can be erased from Swarm |

## Pilot newsroom

No real person or organisation is named in this repository without their consent. When a pilot newsroom agrees, add here: who they are, what has been taken down and when, what they told us they need, in their own words, and a link they approved.
