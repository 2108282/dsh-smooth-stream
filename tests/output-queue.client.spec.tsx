import { act, cleanup, render } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wrapFollowNodeView } from '../src/client/TypewriterToolNodeView.tsx'
import { StreamRelay, streamRelay } from '../src/client/streamRelay.ts'

let frames: Map<number, FrameRequestCallback>
let time: number
let next: number
async function paint(count = 1) {
  for (let index = 0; index < count; index++) await act(async () => {
    const batch = [...frames.values()]
    frames.clear()
    time += 16
    for (const callback of batch) callback(time)
  })
}
beforeEach(() => {
  frames = new Map(); time = 0; next = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = next++; frames.set(id, callback); return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('performance', { now: () => time })
})
afterEach(() => { cleanup(); streamRelay.clearAll(); vi.unstubAllGlobals() })

const Row = wrapFollowNodeView((props) => createElement('article', { 'data-id': props.id }, props.text as string), () => false)
function row(id: string, order: number, kind: string, text: string, sessionId = 'session') {
  return createElement('section', { key: id, 'data-chat-flow-key': id }, createElement(Row, {
    id, text, sessionId, node: { key: id, kind, anchorSeq: order,
      data: { turn: 1, step: 1, ...(kind === 'tool-call' ? { root: {} } : {}) },
      location: { kind: 'step', turn: { turn: 1, status: 'open' }, step: { step: 1, status: 'open' } },
    },
  }))
}

describe('ordered Agent output presentation', () => {
  it('serializes tools, context, todo and future keyed rows independent of backend kind', async () => {
    const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(2)
    const view = render(createElement('main', null,
      row('tool-a', 1, 'tool-call', text), row('context', 2, 'context', text),
      row('todo', 3, 'future-todo', text), row('tool-b', 4, 'tool-call', text)))
    await paint(3)
    const rows = [...view.container.querySelectorAll('article')]
    expect(rows[0]!.textContent!.length).toBeGreaterThan(0)
    expect(rows[0]!.textContent!.length).toBeLessThan(text.length)
    for (const row of rows.slice(1)) {
      expect(row.textContent).toBe('')
      expect((row.closest('div[style]') as HTMLElement).style.opacity).toBe('0')
    }
    // The next row starts only after the previous committed all text.
    for (let frame = 0; frame < 160; frame++) {
      await paint()
      for (let index = 1; index < rows.length; index++) {
        if (rows[index]!.textContent !== '') expect(rows[index - 1]!.textContent).toBe(text)
      }
    }
    for (const row of rows) expect(row.textContent).toBe(text)
  })

  it('keeps reservation and pacing through StrictMode effect replay', async () => {
    const text = 'x'.repeat(80)
    const view = render(createElement(StrictMode, null,
      row('a', 1, 'tool-call', text), row('b', 2, 'context', text)))
    await paint(3)
    expect(view.container.querySelector('[data-id="a"]')!.textContent!.length).toBeGreaterThan(0)
    expect(view.container.querySelector('[data-id="a"]')!.textContent!.length).toBeLessThan(text.length)
    expect(view.container.querySelector('[data-id="b"]')!.textContent).toBe('')
    await paint(120)
    expect(view.container.querySelector('[data-id="b"]')!.textContent).toBe(text)
  })

  it('lets another session progress and releases a removed predecessor', async () => {
    const text = 'x'.repeat(80)
    const tree = (first: boolean) => createElement('main', null,
      first ? row('a', 1, 'tool-call', text) : null,
      row('b', 2, 'context', text), row('other', 3, 'tool-call', text, 'other-session'))
    const view = render(tree(true))
    await paint(3)
    expect(view.container.querySelector('[data-id="b"]')!.textContent).toBe('')
    expect(view.container.querySelector('[data-id="other"]')!.textContent!.length).toBeGreaterThan(0)
    view.rerender(tree(false))
    await paint(3)
    expect(view.container.querySelector('[data-id="b"]')!.textContent!.length).toBeGreaterThan(0)
  })

  it('does not recreate active work when a drained node receives resolved scope metadata', async () => {
    const item = (id: string, order: number, step: number) => createElement('section', { key: id, 'data-chat-flow-key': id }, createElement(Row, {
      id, text: id.repeat(3), sessionId: 's', node: { key: id, kind: 'tool-call', anchorSeq: order,
        data: { turn: 1, step, root: {} } },
    }))
    const view = render(createElement('main', null, item('a', 1, 1), item('b', 2, 1)))
    await paint(30)
    view.rerender(createElement('main', null, item('a', 1, 2), item('b', 2, 2), item('c', 3, 2)))
    await paint(30)
    expect(view.container.querySelector('[data-id="c"]')!.textContent).toBe('ccc')
  })

  it('drains a fast completed result in an open turn and releases on interruption', async () => {
    const text = 'x'.repeat(80)
    const tree = (interrupted: boolean) => createElement('main', null,
      createElement('section', { key: 'fast', 'data-chat-flow-key': 'fast' }, createElement(Row, {
        id: 'fast', text, sessionId: 's', node: { key: 'fast', kind: 'tool-call', anchorSeq: 1,
          data: { turn: 1, step: 1, root: { kind: 'tool-result' }, status: interrupted ? 'interrupted' : 'settled' },
          location: { kind: 'step', turn: { turn: 1, status: 'open' }, step: { step: 1, status: 'open' } },
        },
      })), row('later', 2, 'context', text, 's'))
    const view = render(tree(false))
    await paint(3)
    expect(view.container.querySelector('[data-id="fast"]')!.textContent!.length).toBeLessThan(text.length)
    expect(view.container.querySelector('[data-id="later"]')!.textContent).toBe('')
    view.rerender(tree(true))
    await paint(3)
    expect(view.container.querySelector('[data-id="fast"]')!.textContent).toBe(text)
    expect(view.container.querySelector('[data-id="later"]')!.textContent!.length).toBeGreaterThan(0)
  })

  it('stages atomic subcalls inside one tool tree and restores their original styles', async () => {
    const Nested = wrapFollowNodeView(() => createElement('article', null,
      createElement('div', { 'data-chat-call-id': 'a' }, 'a'.repeat(40)),
      createElement('div', { 'data-chat-call-id': 'b', style: { visibility: 'visible' } }, 'b'.repeat(40))), () => false)
    const view = render(createElement(Nested, { sessionId: 's', node: { key: 'tree', kind: 'tool-call', anchorSeq: 1,
      data: { root: {}, turn: 1, step: 1 } } }))
    await paint(3)
    const a = view.container.querySelector<HTMLElement>('[data-chat-call-id="a"]')!
    const b = view.container.querySelector<HTMLElement>('[data-chat-call-id="b"]')!
    expect(a.textContent!.length).toBeGreaterThan(0)
    expect(b.style.visibility).toBe('hidden')
    expect(b.textContent).toBe('')
    await paint(100)
    expect(a.textContent).toBe('a'.repeat(40))
    expect(b.textContent).toBe('b'.repeat(40))
    expect(b.style.visibility).toBe('visible')
  })

  it('drops a paused source replaced by whitespace instead of replaying stale text', async () => {
    const text = 'a'.repeat(80)
    const tree = (value: string) => createElement('main', null,
      row('first', 1, 'tool-call', text), row('second', 2, 'context', value))
    const view = render(tree('b'.repeat(80)))
    await paint(3)
    view.rerender(tree(' '))
    await paint(140)
    expect(view.container.querySelector('[data-id="second"]')!.textContent).toBe(' ')
  })

  it('unhides later atomic rows when earlier pending text is removed', async () => {
    const Nested = wrapFollowNodeView((props) => createElement('article', null,
      createElement('div', { 'data-chat-call-id': 'a' }, props.text as string),
      createElement('div', { 'data-chat-call-id': 'b' }, 'bbb')), () => false)
    const node = { key: 'tree', kind: 'tool-call', anchorSeq: 1, data: { root: {}, turn: 1, step: 1 } }
    const tree = (text: string) => createElement(Nested, { node, sessionId: 's', text })
    const view = render(tree('aaa'))
    await paint(30)
    view.rerender(tree('a'.repeat(100)))
    await act(async () => {})
    expect(view.container.querySelector<HTMLElement>('[data-chat-call-id="b"]')!.style.visibility).toBe('hidden')
    view.rerender(tree(''))
    await act(async () => {})
    expect(view.container.querySelector<HTMLElement>('[data-chat-call-id="b"]')!.style.visibility).toBe('')
  })

  it('orders tool and generic output leases before later tools and assistant text', () => {
    const relay = new StreamRelay()
    const scope = { session: 's', turn: '1', step: 1, node: 'first', order: 1 }
    const token = relay.acquire(scope, 'output')
    expect(relay.isBlocked({ ...scope, node: 'tool', order: 2 }, 'tool')).toBe(true)
    expect(relay.isBlocked({ ...scope, node: 'assistant', order: 3 }, 'response')).toBe(true)
    expect(relay.isBlocked(scope, 'output')).toBe(false)
    relay.update(token, false)
    expect(relay.isBlocked({ ...scope, node: 'tool', order: 2 }, 'tool')).toBe(false)
  })
})
