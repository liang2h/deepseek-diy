window.__ModuleLoader__.load({
  id: '@local/dsh-codex-mcp',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'localCodexMcp';
    const NAME = 'codex-mcp';
    const HINT = 'status | tools [server] | reload | trust <fingerprint> | untrust | login/logout/cancel <server>';
    const DESCRIPTION = '管理项目 MCP 连接与 OAuth 登录';
    const dictionaries = {
      zh: {label: '项目 MCP', description: DESCRIPTION},
      en: {label: 'Project MCP', description: 'Manage project MCP connections and OAuth sign-in'},
    };
    function McpIcon({size = 16, ...props} = {}) {
      return h('svg', {viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...props},
      h('rect', {x: 8, y: 3, width: 8, height: 6, rx: 1.5}),
      h('path', {d: 'M12 9v4M5 16v-3h14v3'}),
      h('rect', {x: 2, y: 16, width: 6, height: 5, rx: 1.2}),
      h('rect', {x: 16, y: 16, width: 6, height: 5, rx: 1.2}));
    }
    const ours = row => row?.name === NAME && row.hint === HINT && row.description === DESCRIPTION;
    /**
     * Compatibility adapter rechecked on DSH 0.2.2-rc.5, NOT a native row-decoration API.
     * Host commands, input claims, dispatch, authority and command logs stay native.
     * Only replace this row's returned presentation; never read live/directory/DOM.
     */
    function attachCommandFace(service, t, warn = () => {}) {
      let owner = service, descriptor;
      while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, 'candidates'))) owner = Object.getPrototypeOf(owner);
      if (typeof descriptor?.value !== 'function') {warn(); return () => {};}
      const original = descriptor.value;
      const own = Object.getOwnPropertyDescriptor(service, 'candidates');
      let active = true, warned = false;
      const warning = () => {if (!warned) {warned = true; try {warn();} catch { /* diagnostics must not affect commands */ }}};
      const face = row => ({...row, label: t('label'), description: t('description'), icon: McpIcon});
      async function candidates(...args) {
        // Preserve the native caller's `this`, not a Service proxy traced to our ctx.
        const rows = await Reflect.apply(original, this, args);
        if (!active || !Array.isArray(rows)) return rows;
        try {
          // Never invent a row, re-query, or change native filtering/ranking.
          if (!rows.some(ours)) return rows;
          return rows.map(row => ours(row) ? face(row) : row);
        } catch {warning(); return rows;}
      }
      try {
        Object.defineProperty(service, 'candidates', {value: candidates, configurable: true, writable: true, enumerable: own?.enumerable ?? false});
      } catch {warning(); return () => {};}
      return () => {
        active = false;
        // Cordis traces functions on get: compare raw descriptors, never proxy.get.
        // Do not tear down another adapter installed after ours; our inner wrapper
        // remains inert in that case and still delegates with the native caller.
        if (Object.getOwnPropertyDescriptor(service, 'candidates')?.value !== candidates) return;
        if (own) Object.defineProperty(service, 'candidates', own);
        else delete service.candidates;
      };
    }
    return {
      inject: ['locale', 'commandUi'],
      attachCommandFace,
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'codex-mcp: command locale');
        const t = ctx.locale.bind(NS);
        ctx.effect(() => attachCommandFace(ctx.commandUi, t,
          () => console.warn('[codex-mcp] Menu presentation adapter unavailable; native command handling is unchanged.')),
        'codex-mcp: command presentation compatibility');
      },
    };
  },
});
