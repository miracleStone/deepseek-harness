// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type ResourceState = { status: string; value?: { enabled: boolean } }
type StatusProps = {
  provider: string
  sessionId: string
  useResource: (address: string) => ResourceState
  t: (key: string) => string
}
type Registration = { name: string; locale: string }

afterEach(cleanup)

function loadStatus() {
  let component: React.ComponentType<StatusProps> | undefined
  let dictionaries: Record<string, Record<string, string>> = {}
  const active = new Set<string>()
  const disposers: Array<() => void> = []
  const context = {
    locale: { register: (_name: string, values: typeof dictionaries) => {
      dictionaries = values
      return () => {}
    } },
    effect: (setup: () => () => void) => { disposers.push(setup()) },
    resources: { register: () => () => {} },
    slots: {
      inject: (_name: string, setup: () => () => void) => { disposers.push(setup()) },
      register: (options: Registration, view: React.ComponentType<StatusProps>) => {
        active.add(options.name)
        if (options.name === 'conversation.input.model.status') component = view
        return () => { active.delete(options.name) }
      },
    },
  }
  runInNewContext(readFileSync('local-plugins/session-fast/client.js', 'utf8'), {
    window: { __ModuleLoader__: { load: (definition: {
      factory(require: (name: string) => object): { apply(ctx: typeof context): void }
    }) => definition.factory(() => React).apply(context) } },
  })
  if (!component) throw new Error('Fast status component was not registered')
  return {
    Status: component,
    t: (key: string) => dictionaries.zh![key]!,
    active,
    dispose: () => { for (const dispose of disposers.reverse()) dispose() },
  }
}

describe('Fast status outside the model menu', () => {
  it('shows saved session state without opening the menu and follows confirmed changes', () => {
    const plugin = loadStatus()
    const values = new Map([['session-a', true], ['session-b', false]])
    const useResource = vi.fn((address: string): ResourceState => ({
      status: 'live', value: { enabled: values.get(new URL(address).pathname.slice(1))! },
    }))
    const props = { provider: 'openai-codex', sessionId: 'session-a', useResource, t: plugin.t }
    try {
      const view = render(React.createElement(plugin.Status, props))
      expect(screen.getByRole('status').outerHTML).toMatchInlineSnapshot(`"<span class=\"session-fast-badge\" data-state=\"on\" role=\"status\" aria-label=\"此会话已开启 Fast\">Fast 开</span>"`)
      values.set('session-a', false)
      view.rerender(React.createElement(plugin.Status, props))
      expect(screen.queryByRole('status')).toBeNull()
      expect(view.container.innerHTML).toMatchInlineSnapshot(`""`)
      values.set('session-a', true)
      view.rerender(React.createElement(plugin.Status, { ...props, sessionId: 'session-b' }))
      expect(screen.queryByRole('status')).toBeNull()
      view.rerender(React.createElement(plugin.Status, props))
      expect(screen.getByRole('status').textContent).toBe('Fast 开')
      expect(useResource).toHaveBeenCalledWith('dsh-resource://session-fast/session-a')
      expect(useResource).toHaveBeenCalledWith('dsh-resource://session-fast/session-b')
    } finally { plugin.dispose() }
    expect(plugin.active.size).toBe(0)
  })

  it.each(['none', 'loading', 'failed', 'live'])('does not claim Fast is off when the status is %s without a value', (status) => {
    const plugin = loadStatus()
    try {
      render(React.createElement(plugin.Status, {
        provider: 'openai-codex', sessionId: 'session-a', t: plugin.t,
        useResource: () => ({ status }),
      }))
      expect(screen.getByRole('status').textContent).toBe(status === 'none' || status === 'loading' ? 'Fast …' : 'Fast ?')
    } finally { plugin.dispose() }
  })

  it('reports a failed refresh instead of presenting a retained value as confirmed', () => {
    const plugin = loadStatus()
    try {
      render(React.createElement(plugin.Status, {
        provider: 'openai-codex', sessionId: 'session-a', t: plugin.t,
        useResource: () => ({ status: 'failed', value: { enabled: true } }),
      }))
      expect(screen.getByRole('status').textContent).toBe('Fast ?')
    } finally { plugin.dispose() }
  })

  it.each(['deepseek-account', 'antigravity', 'sinapisai'])('leaves %s undecorated and does not request its Fast setting', (provider) => {
    const plugin = loadStatus()
    const useResource = vi.fn(() => ({ status: 'none' }))
    try {
      const view = render(React.createElement(plugin.Status, { provider, sessionId: 'session-a', useResource, t: plugin.t }))
      expect(view.container.innerHTML).toBe('')
      expect(useResource).toHaveBeenCalledWith('')
    } finally { plugin.dispose() }
  })
})
