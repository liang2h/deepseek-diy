import {clampZoom, fitScale, diagramKind, formatZoom} from './diagram.js';
import {css} from './styles.js';
import zh from './locale/zh.json';
import en from './locale/en.json';
import {name as packageName, version} from './package.json';

window.__ModuleLoader__.load({
  id: packageName,
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const {useEffect, useRef, useState, useSyncExternalStore} = React;
    return {
      inject: ['slots', 'locale', 'theme'],
      apply(ctx) {
        const namespace = packageName;
        ctx.effect(() => ctx.locale.register(namespace, {zh: zh.ui, en: en.ui}));
        const t = ctx.locale.bind(namespace);
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = css; document.head.append(style);
          return () => style.remove();
        });
        const subscribeLocale = fn => ctx.locale.subscribe(fn);
        const getLocale = () => ctx.locale.getSnapshot();
        const subscribeTheme = fn => ctx.on('theme/change', fn);
        const getTheme = () => ctx.theme.getTheme();

        function Icon({name}) {
          const paths = {
            diagram: 'M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4',
            minus: 'M5 12h14', plus: 'M5 12h14M12 5v14',
            expand: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
            collapse: 'M3 8h5V3M21 8h-5V3M8 21v-5H3M16 21v-5h5',
          };
          return h('svg', {width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true}, h('path', {d: paths[name]}));
        }

        function DiagramFence({code, streaming, children}) {
          useSyncExternalStore(subscribeLocale, getLocale, getLocale);
          const theme = useSyncExternalStore(subscribeTheme, getTheme, getTheme);
          const dark = theme.active.colorScheme === 'dark';
          const [mode, setMode] = useState('diagram');
          const [expanded, setExpanded] = useState(false);
          const [scale, setScale] = useState(1);
          const [fit, setFit] = useState(false);
          const [available, setAvailable] = useState(0);
          const [attempt, setAttempt] = useState(0);
          const [result, setResult] = useState(null);
          const [error, setError] = useState(null);
          const [busy, setBusy] = useState(false);
          const root = useRef(null), scratch = useRef(null), viewport = useRef(null);
          const kind = diagramKind(code);

          useEffect(() => {
            const observer = new ResizeObserver(entries => setAvailable(entries[0].contentRect.width));
            observer.observe(root.current);
            return () => observer.disconnect();
          }, []);

          useEffect(() => {
            let cancelled = false;
            setError(null); setResult(null);
            if (streaming) { setBusy(false); return; }
            setBusy(true);
            import('./renderer.js').then(({renderDiagram}) => {
              if (cancelled) return null;
              return renderDiagram(code, dark, scratch.current, () => cancelled);
            }).then(value => {
              if (!cancelled) { setResult(value); setBusy(false); }
            }).catch(reason => {
              if (!cancelled) {
                setError({key: reason?.key ?? 'invalid', detail: reason?.key ? '' : String(reason?.message ?? reason).slice(0, 350)});
                setBusy(false);
              }
            });
            return () => { cancelled = true; };
          }, [code, streaming, dark, attempt]);

          const zoom = fit && result ? fitScale(result.width, available) : scale;
          const button = (label, onClick, props, icon) => h('button', {type: 'button', onClick, title: label, 'aria-label': label, ...props}, icon ? h(Icon, {name: icon}) : label);
          const changeZoom = delta => { setScale(clampZoom(zoom + delta)); setFit(false); };
          const showSource = mode === 'source' || streaming || Boolean(error);
          return h('section', {className: 'dsh-diagram', ref: root, 'aria-label': t(kind)},
            h('header', {className: 'dsh-diagram-bar'},
              h('div', {className: 'dsh-diagram-heading'}, h(Icon, {name: 'diagram'}), h('span', {className: 'dsh-diagram-kind'}, t(kind)),
                h('div', {className: 'dsh-diagram-tabs', role: 'group', 'aria-label': t('diagram')},
                  button(t('diagram'), () => setMode('diagram'), {'aria-pressed': mode === 'diagram' && !streaming, disabled: streaming}),
                  button(t('source'), () => setMode('source'), {'aria-pressed': mode === 'source' || streaming}))),
              h('div', {className: 'dsh-diagram-tools'},
                !showSource && h(React.Fragment, null,
                  button(t('fit'), () => setFit(!fit), {'aria-pressed': fit, title: t('fitTitle'), 'aria-label': t('fitTitle'), disabled: !result}),
                  button(t('zoomOut'), () => changeZoom(-0.15), {disabled: !result || zoom <= 0.25}, 'minus'),
                  h('button', {type: 'button', className: 'dsh-diagram-scale', title: t('reset'), 'aria-label': t('reset'), disabled: !result, onClick: () => {setFit(false); setScale(1);}}, formatZoom(zoom)),
                  button(t('zoomIn'), () => changeZoom(0.15), {disabled: !result || zoom >= 3}, 'plus')),
                button(t(expanded ? 'collapse' : 'expand'), () => setExpanded(!expanded), {'aria-pressed': expanded}, expanded ? 'collapse' : 'expand'))),
            streaming && h('div', {className: 'dsh-diagram-status', role: 'status'}, t('streaming')),
            error && mode === 'diagram' && h('div', {className: 'dsh-diagram-status dsh-diagram-error', role: 'status'},
              h('strong', null, t('failed')), t(error.key),
              error.detail && h('span', {className: 'dsh-diagram-detail'}, error.detail),
              button(t('retry'), () => setAttempt(n => n + 1))),
            showSource ? h('div', {className: 'dsh-diagram-source', 'data-expanded': expanded}, children) :
              busy || !result ? h('div', {className: 'dsh-diagram-status', role: 'status'}, t('loading')) :
              h('div', {className: 'dsh-diagram-viewport', ref: viewport, 'data-expanded': expanded, tabIndex: 0, role: 'region', 'aria-label': t(kind)},
                h('div', {className: 'dsh-diagram-art'},
                  h('div', {className: 'dsh-diagram-svg', style: {width: result.width * zoom, height: result.height * zoom}, dangerouslySetInnerHTML: {__html: result.svg}}))),
            h('footer', {className: 'dsh-diagram-footer'},
              h('span', null, t(showSource ? 'sourceHint' : 'hint')),
              h('span', null, t('vector'))),
            h('div', {className: 'dsh-diagram-scratch', ref: scratch, 'aria-hidden': true}));
        }

        ctx.slots.inject('conversation.chat.markdown.fence', () => {
          const disposers = ['mermaid', 'mmd'].map(key => ctx.slots.register({
            name: 'conversation.chat.markdown.fence', id: namespace + '/' + version + '/' + key, key, order: 10,
          }, DiagramFence));
          return () => disposers.forEach(dispose => dispose());
        });
      },
    };
  },
});
