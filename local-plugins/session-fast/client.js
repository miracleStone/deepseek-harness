window.__ModuleLoader__.load({
  id: '@local/dsh-session-fast',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const dictionaries = {
      zh: { label: 'Fast 加速', on: '开启', off: '关闭', loading: '加载中', retry: '加载失败，点击重试', hint: '仅此会话 · 消耗更多订阅额度', saveFailure: 'Fast 设置未保存，请重试', badgeOn: 'Fast 开', badgeOff: 'Fast 关', badgeLoading: 'Fast …', badgeUnknown: 'Fast ?', statusOn: '此会话已开启 Fast', statusOff: '此会话已关闭 Fast', statusLoading: '正在读取此会话的 Fast 状态', statusUnknown: 'Fast 状态读取失败，请打开模型菜单重试' },
      en: { label: 'Fast mode', on: 'On', off: 'Off', loading: 'Loading', retry: 'Could not load · Retry', hint: 'This session · Uses more subscription quota', saveFailure: 'Could not save Fast mode. Try again.', badgeOn: 'Fast on', badgeOff: 'Fast off', badgeLoading: 'Fast …', badgeUnknown: 'Fast ?', statusOn: 'Fast is on for this session', statusOff: 'Fast is off for this session', statusLoading: 'Loading Fast status for this session', statusUnknown: 'Could not load Fast status. Open the model menu to retry.' },
    };
    const styles = `
.session-fast-row{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:44px;padding:5px 7px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.session-fast-copy{display:flex;min-width:0;flex-direction:column;gap:2px}.session-fast-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}.session-fast-value{display:flex;align-items:center;gap:8px;flex:none;color:var(--dsw-alias-label-secondary);font-size:12px}
.session-fast-track{display:block;width:32px;height:18px;padding:2px;box-sizing:border-box;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3)}.session-fast-thumb{display:block;width:14px;height:14px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb);transition:transform 120ms ease}
.session-fast-row[aria-checked="true"] .session-fast-track{background:var(--dsw-alias-brand-primary)}.session-fast-row[aria-checked="true"] .session-fast-thumb{transform:translateX(14px);background:var(--dsw-alias-label-primary-foreground)}
.session-fast-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.session-fast-row:disabled{cursor:default;opacity:.6}
@media(hover:hover){.session-fast-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
@media(prefers-reduced-motion:reduce){.session-fast-thumb{transition:none}}
`;
    const badgeStyles = `
.session-fast-badge{display:inline-flex;flex:none;align-items:center;box-sizing:border-box;white-space:nowrap;gap:4px;padding:0 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.session-fast-badge[data-state="on"]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.session-fast-badge[data-state="unknown"]{color:var(--dsw-alias-state-error-primary)}
`;
    function FastStatus({ provider, sessionId, useResource, t }) {
      const supported = provider === 'openai-codex';
      const resource = useResource(supported ? `dsh-resource://session-fast/${encodeURIComponent(sessionId)}` : '');
      if (!supported) return null;
      const state = resource.status === 'failed' ? 'unknown'
        : resource.status === 'loading' || resource.status === 'none' ? 'loading'
        : resource.value?.enabled === true ? 'on'
        : resource.value?.enabled === false ? 'off' : 'unknown';
      if (state === 'off') return null;
      const keys = { on: ['badgeOn', 'statusOn'], loading: ['badgeLoading', 'statusLoading'], unknown: ['badgeUnknown', 'statusUnknown'] };
      return h(React.Fragment, null,
        h('style', null, badgeStyles),
        h('span', { className: 'session-fast-badge', 'data-state': state, role: 'status', 'aria-label': t(keys[state][1]) }, t(keys[state][0])));
    }
    function FastOption({ provider, locked, busy, sessionId, useResource, save, refresh, t, reportFailure }) {
      const supported = provider === 'openai-codex';
      const resource = useResource(supported ? `dsh-resource://session-fast/${encodeURIComponent(sessionId)}` : '');
      const [saving, setSaving] = React.useState(false);
      if (!supported) return null;
      const loading = resource.status === 'loading' || resource.status === 'none';
      const failed = resource.status === 'failed';
      const enabled = resource.value?.enabled;
      const change = async () => {
        if (saving || loading || locked || busy) return;
        setSaving(true);
        try {
          if (failed) await refresh(sessionId);
          else await save(sessionId, !enabled);
        } catch (error) {
          reportFailure(t('saveFailure'));
        } finally { setSaving(false); }
      };
      return h(React.Fragment, null,
        h('style', null, styles),
        h('button', {
          type: 'button', role: 'menuitemcheckbox', className: 'session-fast-row',
          'aria-label': t('label'), 'aria-checked': enabled === undefined ? 'mixed' : enabled,
          'aria-busy': loading || saving, disabled: locked || busy || loading || saving,
          onClick: change,
        },
        h('span', { className: 'session-fast-copy' },
          h('span', null, t('label')),
          h('span', { className: 'session-fast-hint' },
            failed ? `${t('retry')}${resource.failure?.message ? ` · ${resource.failure.message}` : ''}` : t('hint'))),
        h('span', { className: 'session-fast-value', 'aria-hidden': true },
          loading || saving ? t('loading') : t(enabled ? 'on' : 'off'),
          h('span', { className: 'session-fast-track' }, h('span', { className: 'session-fast-thumb' })))));
    }
    return {
      inject: ['slots', 'locale', 'resources'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('session-fast', dictionaries));
        const channels = new Map();
        const publish = (id, state) => {
          for (const notify of channels.get(id) ?? []) notify({ ok: true, value: state });
        };
        const run = async (id, action, signal) => {
          const writing = action !== 'status';
          const payload = writing ? { sessionId: id, enabled: action === 'on' } : { sessionId: id };
          const response = await fetch('/api/session-fast', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            credentials: 'same-origin',
            cache: 'no-store',
            ...signal === undefined ? {} : { signal },
          });
          const state = await response.json().catch(() => undefined);
          if (!response.ok) throw new Error(state?.error?.message ?? 'Fast settings unavailable');
          if (typeof state?.enabled !== 'boolean') throw new Error('Invalid Fast setting response');
          return state;
        };
        const refresh = async (id) => {
          const state = await run(id, 'status');
          publish(id, state);
          return state;
        };
        const save = async (id, enabled) => {
          const state = await run(id, enabled ? 'on' : 'off');
          publish(id, state);
          return state;
        };
        ctx.effect(() => ctx.resources.register({
          protocol: 'session-fast',
          async *open(address, { signal }) {
            const id = decodeURIComponent(new URL(address).pathname.slice(1));
            const queue = [];
            let wake;
            const notify = frame => { queue.push(frame); wake?.(); wake = undefined; };
            let listeners = channels.get(id);
            if (!listeners) { listeners = new Set(); channels.set(id, listeners); }
            listeners.add(notify);
            const abort = () => { wake?.(); wake = undefined; };
            signal.addEventListener('abort', abort, { once: true });
            try {
              try {
                const state = await run(id, 'status', signal);
                if (queue.length === 0) queue.push({ ok: true, value: state });
              } catch (error) {
                if (queue.length === 0) queue.push({ ok: false, error: { code: 'session-fast/load', message: String(error) } });
              }
              while (!signal.aborted) {
                if (queue.length === 0) await new Promise(resolve => { wake = resolve; });
                while (queue.length > 0 && !signal.aborted) yield queue.shift();
              }
            } finally {
              signal.removeEventListener('abort', abort);
              listeners.delete(notify);
              if (listeners.size === 0) channels.delete(id);
            }
          },
        }));
        ctx.slots.inject('conversation.input.model.options', () => ctx.slots.register({
          name: 'conversation.input.model.options', id: 'session-fast', order: 10,
          locale: 'session-fast', inject: () => ({ save, refresh }),
        }, FastOption));
        ctx.slots.inject('conversation.input.model.status', () => ctx.slots.register({
          name: 'conversation.input.model.status', id: 'session-fast-status', order: 10,
          locale: 'session-fast',
        }, FastStatus));
      },
    };
  },
});
