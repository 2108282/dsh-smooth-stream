import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createElement, useEffect, useState, type ComponentType } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { DEFAULT_STREAM_DEBUG_TUNING, DEFAULT_STREAM_SETTINGS } from '../src/settings.ts'
import type { SmoothStreamCardFace } from '../src/client/smooth-stream-card-controller.ts'
import { debugRuntime } from '../src/client/debugRuntime.ts'

afterEach(() => { cleanup(); debugRuntime.resetRuntime(); localStorage.clear() })

describe('live entry settings', () => {
  it('changes preferences without remounting tool state and restores official output when disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    ctx.provide('connection', { rpc: { call: async (_channel: string, endpoint: string) => ({
      ok: true,
      value: endpoint === 'settings.read' ? {
        ...DEFAULT_STREAM_SETTINGS, enabled: true, controlScroll: false,
        installation: 'development', writable: true, version: '0.6.2', canUpgrade: false,
      } : { debugEnabled: false, tuning: DEFAULT_STREAM_DEBUG_TUNING },
    }) } } as never)
    ctx.slots.register({ name: 'root', children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    } } as never, () => null)
    let mounts = 0
    function OfficialTool() {
      const [count, setCount] = useState(0)
      useEffect(() => { mounts += 1 }, [])
      return createElement('button', { onClick: () => setCount(value => value + 1) }, `count:${count}`)
    }
    ctx.slots.register({ name: 'conversation.chat.node', key: 'tool-call' }, OfficialTool)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const face = ctx.slots.entries('settings.section')[0]!.inject!() as unknown as SmoothStreamCardFace
    const entry = ctx.slots.entries('conversation.chat.node')[0]!
    const props = { node: { data: { root: { kind: 'tool-result' } } } }
    const view = render(createElement(entry.component as ComponentType<typeof props>, props))
    fireEvent.click(view.getByRole('button'))
    expect(view.getByText('count:1')).toBeTruthy()
    await act(async () => { face.edit({ logarithmicFade: false }) })
    expect(view.getByText('count:1')).toBeTruthy()
    expect(mounts).toBe(1)
    await act(async () => { face.edit({ controlScroll: true }) })
    expect(view.getByText('count:1')).toBeTruthy()
    expect(mounts).toBe(1)
    await act(async () => { face.edit({ enabled: false }) })
    expect(view.container.querySelector('[data-entrance]')).toBeNull()
    expect(view.getByRole('button')).toBeTruthy()
    await act(async () => { await fiber.dispose() })
    expect(entry.component).toBe(OfficialTool)
  })
})
