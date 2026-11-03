/** Sortable, URL-safe, collision-resistant post id: base36 time + 6 random chars. */
export function newPostId(now = Date.now()): string {
  const rand = crypto.getRandomValues(new Uint8Array(4));
  const r = Array.from(rand, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 6);
  return `${now.toString(36)}${r}`;
}

export const nowIso = (): string => new Date().toISOString();

/** Ids end up in file paths, so only accept what we generate. */
export const isSafeId = (id: string): boolean => /^[a-z0-9]{6,32}$/.test(id);

export function summarise(markdown: string, max = 180): string {
  const text = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + "…";
}
