import { refToCid } from "./cid";

/**
 * Public ways to open a Swarm reference. The link we hand out is the feed manifest, so every one of
 * these keeps showing the LATEST snapshot. Several independent doors means no single gateway can
 * censor the newsroom: if one blocks it, readers switch to the next, or run their own Bee node.
 */
export interface Gateway {
  id: string;
  label: string;
  /** Build the URL that opens `ref` on this gateway. */
  url: (ref: string) => string;
}

export const GATEWAYS: Gateway[] = [
  { id: "bzz-link", label: "bzz.link", url: (ref) => `https://${refToCid(ref)}.bzz.link/` },
  { id: "ethswarm", label: "gateway.ethswarm.org", url: (ref) => `https://gateway.ethswarm.org/bzz/${ref}/` },
];

/** The censorship-resistant form, for Swarm-aware browsers and local Bee nodes. */
export const nativeUrl = (ref: string): string => `bzz://${ref}`;

/** Local node form, for readers who run Bee themselves (the strongest option). */
export const localNodeUrl = (ref: string, port = 1633): string => `http://localhost:${port}/bzz/${ref}/`;
