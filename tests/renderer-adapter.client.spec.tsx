import { act, cleanup, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createElement, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installRendererAdapter } from '../src/client/rendererAdapter.ts'

afterEach(cleanup)

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } } } as never, (() => null) as never)
  return ctx
}

function register(ctx: Context, key: string, component: unknown, priority = 0) {
  ctx.slots.register({ name: 'conversation.chat.node', key, priority } as never, component as never)
  return ctx.slots.entries('conversation.chat.node').find(entry => entry.options.key === key)!
}

describe('renderer adapter', () => {
  it('wraps the official entry in place, forwards props, and restores it on dispose', async () => {
    const ctx = await setup()
    const Official = vi.fn(({ label }: { label: string }) => createElement('span', null, label))
    const options = { name: 'conversation.chat.node', key: 'assistant-step', priority: 20, children: { 'assistant.child': { kind: 'list', scope: 'session' } } }
    ctx.slots.register(options as never, Official as never)
    const entry = ctx.slots.entries('conversation.chat.node')[0]!
    const metadata = entry.options
    const dispose = installRendererAdapter(ctx, (_key, component) => {
      const Inner = component as (props: { label: string }) => ReturnType<typeof createElement>
      return (props: { label: string }) => createElement(Inner, props)
    })
    expect(entry.options).toBe(metadata)
    expect(entry.options).toMatchObject({ key: 'assistant-step', priority: 20 })
    expect(entry.children).toBeDefined()
    expect(entry.component).not.toBe(Official)
    const view = render(createElement(entry.component as never, { label: 'forwarded' }))
    expect(view.getByText('forwarded')).toBeTruthy()
    expect(Official).toHaveBeenCalledWith(expect.objectContaining({ label: 'forwarded' }), {})
    dispose()
    expect(entry.component).toBe(Official)
  })

  it('renders the original component immediately when its adapter is disposed', async () => {
    const ctx = await setup()
    const Official = () => createElement('span', null, 'official')
    const entry = register(ctx, 'assistant-step', Official)
    const dispose = installRendererAdapter(ctx, () => () => createElement('span', null, 'wrapped'))
    const view = render(createElement(entry.component as never))
    expect(view.getByText('wrapped')).toBeTruthy()
    await act(async () => { dispose() })
    expect(view.getByText('official')).toBeTruthy()
    expect(entry.component).toBe(Official)
  })

  it('wraps late registrations and emits one refresh per changed batch', async () => {
    const ctx = await setup()
    let wrappedRenders = 0
    const Counter = () => {
      wrappedRenders += 1
      const [value, setValue] = useState(0)
      return createElement('button', { onClick: () => setValue(value + 1) }, String(value))
    }
    const dispose = installRendererAdapter(ctx, (_key, component) => {
      const Inner = component as () => ReturnType<typeof createElement>
      return () => {
        wrappedRenders += 1
        return createElement(Inner)
      }
    })
    const first = register(ctx, 'tool-call', Counter)
    await act(async () => { await Promise.resolve() })
    expect(first.component).not.toBe(Counter)
    const view = render(createElement(first.component as never))
    const renderCount = wrappedRenders
    const second = register(ctx, 'context', () => createElement('span', null, 'context'))
    const third = register(ctx, 'command', () => createElement('span', null, 'command'))
    await act(async () => { await Promise.resolve() })
    expect(second.component).not.toBeUndefined()
    expect(third.component).not.toBeUndefined()
    expect(wrappedRenders).toBeGreaterThan(renderCount)
    await act(async () => { view.getByRole('button').click() })
    expect(view.getByRole('button').textContent).toBe('1')
    dispose()
    expect(first.component).toBe(Counter)
  })
})
