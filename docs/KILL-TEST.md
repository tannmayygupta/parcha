# The kill test

**Claim:** once the newsroom's own server and domain are gone, the link still shows their latest work.

Parcha never had a server or domain in the path, so the test is about proving that nothing else secretly was.

## Automated

```bash
npm run verify -- <feed manifest> --min-version <N> --json docs/evidence/verify.json
```

For every independent door into Swarm (bzz.link, gateway.ethswarm.org, and any `--gateway` / `--bee` you add) it fetches `data/posts.json`, `data/seal.json`, `data/site.json`, checks the version is at least `N`, and **verifies the publisher's signature**. Exit code 0 means at least one door served a correctly signed latest edition.

## Manual protocol (what to record for the demo)

1. Publish edition *N* from the publisher app. Note the permanent link.
2. **Take away everything of ours.** Stop the dev server, close the publisher tab, clear local storage, disconnect the machine's own Bee node if one was used for uploading.
3. From a *different* device or network, open the permanent link on bzz.link. Confirm edition *N* is shown and the story says "Verified".
4. Publish edition *N+1* (from the restored app: new browser profile → *Restore* with link + key backup).
5. Reload the **same link** from the other device. Edition *N+1* appears, with no change to the link.
6. Break a mirror on purpose (offline, or block one gateway's hostname): the reader's mirror list and `npm run verify` show the others still serve it.

## Evidence

_Filled in from the live run (date, link, command output, screenshots)._
