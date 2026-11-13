import {Lexer} from 'marked';

// Parse Markdown, never render parser-produced HTML. Only the fixed elements and
// attributes below enter React; model output is always text, not markup or props.
const element = (tag, children = [], props = {}) => ({tag, props, children});
const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'};
function decodeText(value) {
  return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (original, name) => {
    if (name[0] !== '#') return entities[name.toLowerCase()];
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original;
  });
}

export function safeMarkdownUrl(value) {
  const href = decodeText(value).trim();
  if (/[\u0000-\u0020\u007f]/.test(href) || !/^(?:https?:\/\/|mailto:)/i.test(href)) return undefined;
  try {
    const url = new URL(href);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

function inlineNodes(tokens = []) {
  return tokens.flatMap(token => {
    switch (token.type) {
      case 'strong': return [element('strong', inlineNodes(token.tokens))];
      case 'em': return [element('em', inlineNodes(token.tokens))];
      case 'del': return [element('del', inlineNodes(token.tokens))];
      case 'codespan': return [element('code', [token.text])];
      case 'br': return [element('br')];
      case 'link': {
        const content = inlineNodes(token.tokens);
        const href = safeMarkdownUrl(token.href);
        return href ? [element('a', content, {href, ...(token.title ? {title: decodeText(token.title)} : {}), target: '_blank', rel: 'noopener noreferrer'})] : content;
      }
      // Do not fetch model-supplied images or execute embedded HTML.
      case 'image': return [decodeText(token.text)];
      case 'html': return [token.raw];
      case 'escape': return [token.text];
      default: return token.tokens ? inlineNodes(token.tokens) : [decodeText(token.text || token.raw || '')];
    }
  });
}

function blockNodes(tokens, tableLabel) {
  return tokens.flatMap(token => {
    switch (token.type) {
      case 'space': case 'def': return [];
      case 'heading': return [element(`h${token.depth}`, inlineNodes(token.tokens))];
      case 'paragraph': return [element('p', inlineNodes(token.tokens))];
      case 'text': return inlineNodes(token.tokens || [{type: 'text', text: token.text}]);
      case 'hr': return [element('hr')];
      case 'code': {
        const language = token.lang?.split(/\s+/)[0];
        const pre = element('pre', [element('code', [token.text])]);
        return language ? [element('div', [element('div', [language], {className: 'sc-code-language'}), pre], {className: 'sc-code-block'})] : [pre];
      }
      case 'blockquote': return [element('blockquote', blockNodes(token.tokens, tableLabel))];
      case 'list': return [element(token.ordered ? 'ol' : 'ul', token.items.map(item => element('li', [
        ...(item.task ? [element('input', [], {type: 'checkbox', checked: item.checked, disabled: true, readOnly: true})] : []),
        ...blockNodes(item.tokens, tableLabel)
      ], item.task ? {className: 'sc-task-item'} : {})), token.ordered ? {start: token.start} : {})];
      case 'table': {
        const row = (cells, header) => element('tr', cells.map((cell, index) => element(header ? 'th' : 'td', inlineNodes(cell.tokens), {
          ...(header ? {scope: 'col'} : {}), ...(token.align[index] ? {style: {textAlign: token.align[index]}} : {})
        })));
        return [element('div', [element('table', [element('thead', [row(token.header, true)]), element('tbody', token.rows.map(cells => row(cells, false)))])],
          {className: 'sc-table-scroll', role: 'region', 'aria-label': tableLabel, tabIndex: 0})];
      }
      case 'html': return [element('p', [token.raw])];
      default: return [element('p', [token.raw || token.text || ''])];
    }
  });
}

// The plain tree is separately testable without React, DOM, or a mock page.
export function markdownTree(value, tableLabel = 'Table') {
  return blockNodes(Lexer.lex(value.replace(/\r\n?/g, '\n'), {gfm: true, breaks: false}), tableLabel);
}

export function renderMarkdown(value, createElement, tableLabel) {
  const render = (node, key) => typeof node === 'string' ? node : createElement(node.tag, {...node.props, key}, ...node.children.map(render));
  return createElement('div', {className: 'sc-markdown'}, ...markdownTree(value, tableLabel).map(render));
}
