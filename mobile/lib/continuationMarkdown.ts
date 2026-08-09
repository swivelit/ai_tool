const SAFE_PREFIX = /^(?:`{3,8}|~{3,8})(?:html|xml|css|javascript|js|typescript|ts|json|python|py|bash|sh|shell|sql|text|code)?\n$/;

export function continuationMarkdown(content: string, prefix?: string | null) {
  const value = String(content || "");
  const candidate = String(prefix || "");
  return candidate && SAFE_PREFIX.test(candidate) && !/^\s*(?:`{3,}|~{3,})/.test(value) ? candidate + value : value;
}

export function stitchContinuationMarkdown(segments: readonly { content: string; continuation_rewind_characters?: number }[]) {
  if (!segments.length) return "";
  let combined = String(segments[0].content || "");
  for (const segment of segments.slice(1)) {
    const requested = Number(segment.continuation_rewind_characters || 0);
    const rewind = Number.isInteger(requested) ? Math.max(0, Math.min(combined.length, requested)) : 0;
    if (rewind) combined = combined.slice(0, -rewind);
    const next = String(segment.content || "");
    if (!rewind && combined && next && !combined.endsWith("\n") && !next.startsWith("\n")) combined += "\n";
    combined += next;
  }
  return combined;
}
