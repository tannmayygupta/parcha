import DOMPurify from "dompurify";
import { Marked } from "marked";

/**
 * Markdown -> safe HTML. Used for the editor preview AND by the reader, so what the editor
 * shows is what readers get. Defence in depth:
 *  - raw HTML in markdown is dropped by the renderer,
 *  - the result is sanitised by DOMPurify,
 *  - <img> may only point inside the snapshot (media/...): no third-party requests, so nobody can
 *    learn which readers opened a story, and nothing external can vanish and break a story,
 *  - external links get rel=noopener noreferrer.
 */
const md = new Marked({ gfm: true, breaks: true });
md.use({ renderer: { html: () => "" } });

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (!/^media\/[A-Za-z0-9._-]+$/.test(src)) node.remove();
      else node.setAttribute("loading", "lazy");
    }
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (/^(https?:|bzz:)/i.test(href)) {
        node.setAttribute("rel", "noopener noreferrer nofollow");
        node.setAttribute("target", "_blank");
      }
    }
  });
}

export function renderMarkdown(markdown: string): string {
  ensureHooks();
  const html = md.parse(markdown, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "srcset"],
    ALLOWED_URI_REGEXP: /^(?:https?:|bzz:|mailto:|#|media\/)/i,
  });
}
