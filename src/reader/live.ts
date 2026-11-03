import { decodeAnnouncement, type Announcement } from "../live/protocol";
import type { SiteMeta } from "../shared/types";

export type LiveState = "connecting" | "live" | "off";

export interface LiveHandle {
  stop(): void;
}

/**
 * Optional live layer for readers. Loaded lazily (swarm-pubsub is a separate chunk), so a broken or
 * blocked broker can never stop the page from rendering: polling keeps working regardless.
 */
export async function startLive(
  site: SiteMeta,
  onAnnouncement: (a: Announcement) => void,
  onState: (s: LiveState, detail?: string) => void,
): Promise<LiveHandle> {
  let stopped = false;
  let close: (() => void) | undefined;
  const owner = site.feed.owner.toLowerCase();

  const attempt = async (n: number): Promise<void> => {
    if (stopped || !site.live) return;
    onState("connecting");
    try {
      const { connect } = await import("swarm-pubsub");
      const broker = await withTimeout(connect(site.live.broker), 12_000, "broker connection timed out");
      const sub = await broker.subscribe(owner, site.live.topic, {
        onMessage: (m) => {
          // The library proves who signed a message; only the newsroom's own key counts.
          if (m.publisher.toLowerCase() !== owner) return;
          const a = decodeAnnouncement(m.text());
          if (a) onAnnouncement(a);
        },
        onClose: () => {
          if (stopped) return;
          onState("off", "live channel closed");
          setTimeout(() => void attempt(n + 1), backoff(n));
        },
      });
      close = () => {
        sub.close();
        void broker.close();
      };
      if (stopped) close();
      else onState("live");
    } catch (e) {
      onState("off", (e as Error).message);
      if (!stopped && n < 6) setTimeout(() => void attempt(n + 1), backoff(n));
    }
  };

  void attempt(0);
  return {
    stop() {
      stopped = true;
      close?.();
    },
  };
}

const backoff = (n: number) => Math.min(60_000, 3_000 * 2 ** n);

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
