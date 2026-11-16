export const MAX_SOURCE_LENGTH = 48_000;
export const MAX_EDGES = 700;
export const MAX_SVG_LENGTH = 2_500_000;

const kinds = [
  [/^(?:sequenceDiagram)\b/i, 'sequence'],
  [/^(?:flowchart|graph)\b/i, 'flowchart'],
  [/^classDiagram\b/i, 'class'],
  [/^stateDiagram(?:-v2)?\b/i, 'state'],
  [/^erDiagram\b/i, 'er'],
  [/^gantt\b/i, 'gantt'],
  [/^pie\b/i, 'pie'],
  [/^mindmap\b/i, 'mindmap'],
  [/^timeline\b/i, 'timeline'],
  [/^gitGraph\b/i, 'git'],
  [/^journey\b/i, 'journey'],
  [/^xychart(?:-beta)?\b/i, 'chart'],
  [/^block(?:-beta)?\b/i, 'block'],
  [/^architecture(?:-beta)?\b/i, 'architecture'],
  [/^sankey(?:-beta)?\b/i, 'sankey'],
  [/^quadrantChart\b/i, 'quadrant'],
];

export class DiagramError extends Error {
  constructor(key) { super(key); this.key = key; }
}

export function prepareSource(raw) {
  if (raw.length > MAX_SOURCE_LENGTH) throw new DiagramError('tooLarge');
  let code = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  // Iterate to a fixed point: removing one config block can reveal another.
  // In particular, directives before frontmatter must not expose fresh config.
  for (let pass = 0; ; pass++) {
    if (pass > 32) throw new DiagramError('invalid');
    const before = code;
    code = code.replace(/%%\{[\s\S]*?\}%%/g, '').trim();
    if (/^---[ \t]*\n/.test(code)) {
      const lines = code.split('\n');
      const end = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line));
      if (end < 0) throw new DiagramError('invalid');
      code = lines.slice(end + 1).join('\n').trim();
    }
    if (code === before) break;
  }
  if (!code) throw new DiagramError('empty');
  // Shape metadata is YAML (including quoted/escaped keys). Disable that entire
  // optional syntax rather than trying to recognize image keys with a regex.
  if (/@\s*\{/.test(code)) throw new DiagramError('unsupportedMetadata');
  // Mermaid inserts author CSS before returning SVG. Keep appearance plugin-owned
  // instead of attempting to sanitize a CSS/diagram hybrid with token regexes.
  if (/(?:^|[;\n])\s*(?:classDef|linkStyle|style)\s+/i.test(code)) throw new DiagramError('customStyle');
  if (/<\s*(?:img|image|iframe)\b|!\[[^\]]*\]\s*\(|@import/i.test(code)) throw new DiagramError('externalAsset');
  return code;
}

export function diagramKind(raw) {
  let code;
  try { code = prepareSource(raw).replace(/^\s*%%[^\n]*(?:\n|$)/gm, '').trim(); }
  catch { return 'diagram'; }
  return kinds.find(([pattern]) => pattern.test(code))?.[1] ?? 'diagram';
}

export function formatZoom(scale) { return scale < 0.01 ? '<1%' : Math.round(scale * 100) + '%'; }
export function clampZoom(value) { return Math.min(3, Math.max(0.25, Math.round(value * 100) / 100)); }
export function fitScale(width, available) {
  return width > 0 && available > 0 ? Math.min(1, Math.max(1, available - 40) / width) : 1;
}

// Only local paint-server references are allowed; escaped CSS and network URLs are not.
export function safeCssValue(value) {
  if (/[\\@<>]/.test(value)) return false;
  if (/(?:url|(?:-webkit-)?image-set|image|src)\s*\(/i.test(value)) return /^url\(\s*["']?#[a-zA-Z0-9_-]+["']?\s*\)$/i.test(value.trim());
  return !/expression\s*\(|-moz-binding|javascript:/i.test(value);
}

export function createRenderQueue() {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}
