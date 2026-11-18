/**
 * Output shaping: keeps tool results small and readable for the model.
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** Converts Simpro rich text (HTML) into plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const looksLikeHtml = (s: string) => /<\/?(p|br|div|span|ul|ol|li|strong|b|em|table|font)\b/i.test(s);

/**
 * Recursively drops empty values (null, "", {}) and converts HTML strings to
 * text. Zero, false and empty lists are kept: they are meaningful answers.
 */
export function clean(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const s = looksLikeHtml(value) ? htmlToText(value) : value;
    return s === "" ? undefined : s;
  }
  if (Array.isArray(value)) {
    return value.map(clean).filter((v) => v !== undefined);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = clean(v);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

/**
 * Serialises a result. If it is longer than maxChars, the longest array is
 * cut down until it fits and a note says how many items were left out.
 */
export function toText(data: unknown, maxChars: number): string {
  let json = JSON.stringify(data, null, 1);
  if (json === undefined) return '{"success": true}';
  if (json.length <= maxChars) return json;

  const copy = structuredClone(data) as unknown;
  const arrays: unknown[][] = [];
  const collect = (v: unknown) => {
    if (Array.isArray(v)) {
      arrays.push(v);
      v.forEach(collect);
    } else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(copy);
  arrays.sort((a, b) => b.length - a.length);
  const biggest = arrays[0];
  if (biggest && biggest.length > 1) {
    const original = biggest.length;
    let keep = original;
    while (keep > 1) {
      keep = Math.max(1, Math.floor(keep * 0.7));
      biggest.length = keep;
      json = JSON.stringify(copy, null, 1);
      if (json.length <= maxChars - 200) break;
    }
    const note = `\n\n[Result too large: showing ${keep} of ${original} items. Ask for fewer columns, a smaller pageSize, or narrower filters to see the rest.]`;
    if (json.length <= maxChars) return json + note;
  }
  return (
    json.slice(0, maxChars) +
    `\n\n[Result cut off at ${maxChars} characters. Ask for fewer columns or narrower filters.]`
  );
}
