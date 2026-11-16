import mermaid from 'mermaid';
import createDOMPurify from 'dompurify';
import {MAX_SOURCE_LENGTH, MAX_EDGES, MAX_SVG_LENGTH, DiagramError, prepareSource, safeCssValue, createRenderQueue} from './diagram.js';

const enqueue = createRenderQueue();
let serial = 0;

function diagramConfig(dark) {
  // A restrained diagram palette: blue structure, quiet grey scaffolding, warm notes.
  const c = dark ? {
    bg: '#1c2029', text: '#e3e9f3', muted: '#a4b2c8', line: '#94a8c5',
    primary: '#293c5b', border: '#88a9df', secondary: '#263f43', tertiary: '#30333f',
    note: '#403b2c', noteBorder: '#aa9969',
  } : {
    bg: '#ffffff', text: '#25344a', muted: '#63748a', line: '#8495ab',
    primary: '#edf3ff', border: '#7798cc', secondary: '#eaf5f2', tertiary: '#f3f4f8',
    note: '#fff8e8', noteBorder: '#d3bf88',
  };
  return {
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    maxTextSize: MAX_SOURCE_LENGTH, maxEdges: MAX_EDGES,
    htmlLabels: false, theme: 'base', look: 'classic',
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    themeVariables: {
      darkMode: dark, background: c.bg, primaryColor: c.primary, primaryBorderColor: c.border,
      primaryTextColor: c.text, secondaryColor: c.secondary, secondaryTextColor: c.text,
      tertiaryColor: c.tertiary, tertiaryTextColor: c.text, lineColor: c.line,
      textColor: c.text, fontSize: '14px', mainBkg: c.primary, nodeBorder: c.border,
      clusterBkg: c.tertiary, clusterBorder: c.line,
      actorBkg: c.primary, actorBorder: c.border, actorTextColor: c.text, actorLineColor: c.line,
      signalColor: c.line, signalTextColor: c.text, labelBoxBkgColor: c.tertiary,
      labelBoxBorderColor: c.line, labelTextColor: c.text, loopTextColor: c.text,
      activationBkgColor: c.secondary, activationBorderColor: c.border,
      noteBkgColor: c.note, noteBorderColor: c.noteBorder, noteTextColor: c.text,
      sequenceNumberColor: c.bg, edgeLabelBackground: c.bg,
    },
    flowchart: {htmlLabels: false, curve: 'basis', nodeSpacing: 40, rankSpacing: 56, padding: 18, useMaxWidth: false},
    sequence: {
      useMaxWidth: false, diagramMarginX: 24, diagramMarginY: 24, actorMargin: 48,
      width: 148, height: 52, boxMargin: 12, noteMargin: 16, messageMargin: 36,
      mirrorActors: false, wrap: true, wrapPadding: 12, actorFontSize: 14, actorFontWeight: 600,
      noteFontSize: 13, noteFontWeight: 400, messageFontSize: 14, messageFontWeight: 400,
    },
    themeCSS: '[id$="-sequencenumber"]{fill:' + (dark ? c.line : c.text) + '}.actor{font-weight:600}.actor-line{stroke-dasharray:4 5;opacity:.6}.messageLine0,.messageLine1{stroke-width:1.5}.note{stroke-width:1}.labelBox{stroke-width:1}.cluster rect{rx:10;ry:10}.node rect{rx:8;ry:8}.node polygon{fill:' + c.secondary + '}.edgeLabel{font-size:13px}.edge-pattern-dotted{opacity:.75}',
  };
}

const svgCssProperties = new Set(('fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit color opacity font font-family font-size font-weight font-style font-variant text-anchor dominant-baseline alignment-baseline text-decoration white-space line-height letter-spacing word-spacing paint-order rx ry r cx cy x y width height max-width min-width max-height min-height padding margin display visibility overflow marker marker-start marker-mid marker-end filter clip-path vector-effect background-color text-align').split(' '));
function cleanDeclarations(style) {
  for (const key of Array.from(style)) {
    if (!svgCssProperties.has(key) || !safeCssValue(style.getPropertyValue(key))) style.removeProperty(key);
  }
  return style.cssText;
}

function cleanStyles(text, id) {
  // CSS is parsed by the real browser, never by a regex pretending to parse CSS.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text);
  return Array.from(sheet.cssRules).flatMap(rule => {
    if (rule.type !== 1) return []; // no @import, @font-face, animation or global rules
    const selectors = rule.selectorText.split(',').map(s => s.trim());
    if (!selectors.every(s => s === '#' + id || s.startsWith('#' + id + ' ') || s.startsWith('#' + id + ':'))) return [];
    return [rule.selectorText + '{' + cleanDeclarations(rule.style) + '}'];
  }).join('\n');
}

function sanitizeSvg(svg, id) {
  if (svg.length > MAX_SVG_LENGTH) throw new DiagramError('tooLarge');
  const purifier = createDOMPurify(window);
  const clean = purifier.sanitize(svg, {
    USE_PROFILES: {svg: true, svgFilters: true},
    FORBID_TAGS: ['foreignObject', 'image', 'a', 'script', 'animate', 'animateMotion', 'animateTransform', 'set'],
    FORBID_ATTR: ['target', 'tabindex'],
  });
  const document = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const root = document.documentElement;
  if (root.localName !== 'svg' || document.querySelector('parsererror')) throw new DiagramError('invalid');
  for (const node of root.querySelectorAll('*')) {
    if (node.localName === 'style') node.textContent = cleanStyles(node.textContent, id);
    if (node.hasAttribute('style')) node.setAttribute('style', cleanDeclarations(node.style));
    for (const attr of Array.from(node.attributes)) {
      if (/href$/i.test(attr.name) && !/^#[\w-]+$/.test(attr.value)) node.removeAttribute(attr.name);
      if (/url\s*\(/i.test(attr.value) && !safeCssValue(attr.value)) node.removeAttribute(attr.name);
    }
  }
  root.setAttribute('id', id);
  root.removeAttribute('style');
  root.setAttribute('width', '100%'); root.setAttribute('height', '100%');
  root.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  const box = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0 || box[2] > 60_000 || box[3] > 100_000) throw new DiagramError('tooLarge');
  return {svg: new XMLSerializer().serializeToString(root), width: box[2], height: box[3]};
}

export function renderDiagram(raw, dark, container, isCancelled = () => false) {
  return enqueue(async () => {
    if (isCancelled()) return null;
    const code = prepareSource(raw);
    const id = 'dshdiagram' + (++serial) + Math.random().toString(36).slice(2, 9);
    const config = diagramConfig(dark);
    // Defense in depth: all plugin-owned settings are initializer-only.
    config.secure = [...Object.keys(config), 'secure'];
    mermaid.initialize(config);
    try {
      const result = await mermaid.render(id, code, container);
      if (isCancelled()) return null;
      // Do not call bindFunctions: diagrams have no callbacks or outgoing navigation.
      return sanitizeSvg(result.svg, id);
    } finally {
      container.replaceChildren();
    }
  });
}
