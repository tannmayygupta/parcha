/** Tiny DOM helpers shared by the reader and the publisher. Text is always set as text, never as HTML. */

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) if (k) e.append(k);
  return e;
}

/** replaceChildren that skips null/false (which would otherwise render as the text "null"). */
export function fill(parent: Element, ...kids: Child[]): void {
  parent.replaceChildren(...(kids.filter(Boolean) as (Node | string)[]));
}
