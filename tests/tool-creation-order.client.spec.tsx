import { act, cleanup, render } from '@testing-library/react'
import { createElement, Fragment, useLayoutEffect, useState, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToolPresentationLedger, wrapFollowNodeView, type FollowWrapProps } from '../src/client/TypewriterToolNodeView.tsx'
import { setForegroundRecoveryDelay } from '../src/client/backgroundRecovery.ts'
import { streamRelay } from '../src/client/streamRelay.ts'

interface Call {
  callId: string
  text: string
  subCalls: Call[]
  phase?: string
  kind?: string
  result?: string
  denied?: boolean
}
interface Creation {
  id: string
  previous: Array<[string, string]>
}
let frames: Map<number, FrameRequestCallback>
let time: number
let next: number
let renders: Map<string, number>
let effects: Creation[]
let slots: unknown[]
let fallbacks: unknown[]
const renderSlot = (_key: string, source: Call) => createElement(Atomic, { source })
const fallback = (source: Call) => createElement(Atomic, { source })
const call = (callId: string, text = callId.repeat(18), subCalls: Call[] = []): Call => ({ callId, text, subCalls, phase: 'running' })

function Atomic({ source }: { source: Call }) {
  renders.set(source.callId, (renders.get(source.callId) ?? 0) + 1)
  const [clicks, setClicks] = useState(0)
  useLayoutEffect(() => {
    effects.push({ id: source.callId, previous: [...document.querySelectorAll<HTMLElement>('[data-call-text]')]
      .filter(row => row.dataset.callText !== source.callId)
      .map(row => [row.dataset.callText!, row.textContent!]) })
  }, [])
  return createElement('article', { 'data-chat-call-id': source.callId },
    createElement('header', { 'data-tool-header': source.callId },
      createElement('svg', { 'data-tool-icon': source.callId }, createElement('path', { d: 'M0 0h1' }))),
    createElement('span', { 'data-call-text': source.callId }, source.text),
    createElement('button', { 'aria-label': source.callId, onClick: () => setClicks(value => value + 1), 'data-clicks': clicks }))
}
function Tree({ source }: { source: Call }): ReactElement {
  return createElement(Fragment, null,
    // A denied review uses the same fallback path as the official tree. It is
    // still source-projected even when no keyed tool-view slot is invoked.
    source.denied ? fallback(source) : renderSlot('tool.call.toolview', source),
    ...source.subCalls.map(child => createElement(Tree, { key: child.callId, source: child })))
}
const Tool = wrapFollowNodeView((props: FollowWrapProps) => {
  slots.push(props.renderSlot)
  fallbacks.push(props.fallback)
  return createElement(Tree, { source: (props.node as { data: { root: Call } }).data.root })
}, () => false)
const Seed = wrapFollowNodeView(props => createElement('span', { 'data-seed': true }, props.text as string), () => false)
function node(id: string, order: number, root: unknown, settled = false, turn = 1) {
  return { key: id, kind: 'tool-call', anchorSeq: order,
    data: { turn, step: 1, root, ...(settled ? { status: 'settled' } : {}) },
    location: { kind: 'step', turn: { turn, status: 'open' }, step: { step: 1, status: 'open' } } }
}
function item(id: string, order: number, root: Call, settled = false, turn = 1) {
  return createElement('section', { key: id, 'data-chat-flow-key': id }, createElement(Tool, {
    node: node(id, order, root, settled, turn), sessionId: 'tool-creation', renderSlot, fallback,
  }))
}
function seed() {
  return createElement(Seed, { key: 'seed', node: node('seed', 1, {}), text: 'seed', sessionId: 'tool-creation' })
}
async function signal(hidden: boolean) {
  await act(async () => { window.dispatchEvent(new Event(hidden ? 'dsha:background' : 'dsha:foreground')) })
}
async function paint(count = 1) {
  for (let index = 0; index < count; index++) await act(async () => {
    const batch = [...frames.values()]
    frames.clear()
    time += 16
    for (const callback of batch) callback(time)
  })
}
const text = (id: string) => document.querySelector(`[data-call-text="${id}"]`)?.textContent
const mounted = () => [...document.querySelectorAll<HTMLElement>('[data-tool-icon]')].map(row => row.dataset.toolIcon!)
async function drain(count = 200) { await paint(count) }
beforeEach(() => {
  frames = new Map(); time = 0; next = 1; renders = new Map(); effects = []; slots = []; fallbacks = []
  vi.stubGlobal('performance', { now: () => time })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = next++; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  setForegroundRecoveryDelay(0)
})
afterEach(async () => {
  cleanup(); clearToolPresentationLedger(); streamRelay.clearAll(); setForegroundRecoveryDelay(0)
  await act(async () => {})
  vi.unstubAllGlobals()
})

describe('tool renderer creation admission', () => {
  it('keeps later renderer, effects, header and SVG uncreated behind a predecessor', async () => {
    const token = streamRelay.acquire({ session: 'tool-creation', turn: '1', step: 1, node: 'assistant', order: 1 }, 'response')
    const view = render(item('first', 2, call('a', 'a'.repeat(60), [call('b')])))
    await paint(5)
    expect(renders.size).toBe(0)
    expect(effects).toEqual([])
    expect(view.container.querySelector('header')).toBeNull()
    expect(view.container.querySelector('svg')).toBeNull()
    await act(async () => { streamRelay.release(token) })
    await paint(3)
    expect(mounted()).toEqual(['a'])
    expect(renders.has('b')).toBe(false)
    await drain()
    expect(effects.map(event => event.id)).toEqual(['a', 'b'])
  })

  it('keeps the actual renderer absent behind an unmanaged typing predecessor', async () => {
    const tree = (typing: boolean) => createElement('main', null,
      createElement('section', { 'data-chat-flow-key': 'unmanaged' }, createElement('span', { 'data-streaming': typing ? 'true' : undefined }, 'previous')),
      item('tool', 2, call('a')))
    const view = render(tree(true))
    await paint(5)
    expect(renders.size).toBe(0)
    expect(effects).toEqual([])
    expect(view.container.querySelector('svg')).toBeNull()
    view.rerender(tree(false))
    await drain(60)
    expect(effects.map(event => event.id)).toEqual(['a'])
  })

  it('matches incremental and recovered snapshot creation/effect/SVG order across rows', async () => {
    const a = call('a', 'a'.repeat(24))
    const b = call('b', 'b'.repeat(24), [call('c', 'c'.repeat(24))])
    b.denied = true
    const d = call('d', 'd'.repeat(24))
    const view = render(createElement('main', null, item('tree', 2, a)))
    await drain(60)
    view.rerender(createElement('main', null, item('tree', 2, { ...a, subCalls: [b] })))
    await drain(140)
    view.rerender(createElement('main', null, item('tree', 2, { ...a, subCalls: [b] }), item('later', 3, d)))
    await drain(80)
    const incremental = effects.map(event => event.id)
    expect(incremental).toEqual(['a', 'b', 'c', 'd'])
    expect(mounted()).toEqual(incremental)
    cleanup(); clearToolPresentationLedger(); streamRelay.clearAll()
    await act(async () => {})
    renders.clear(); effects = []; slots = []; fallbacks = []
    const recovered = render(createElement('main', null, seed()))
    await drain(30)
    await signal(true)
    recovered.rerender(createElement('main', null, seed(), item('tree', 2, { ...a, subCalls: [b] }), item('later', 3, d)))
    await signal(false)
    expect(renders.has('b')).toBe(false)
    expect(renders.has('c')).toBe(false)
    expect(renders.has('d')).toBe(false)
    for (let index = 0; index < 240; index++) {
      await paint()
      const ids = mounted()
      expect(ids).toEqual(incremental.slice(0, ids.length))
      for (const id of ids.slice(1)) {
        const before = incremental[incremental.indexOf(id) - 1]!
        expect(text(before)).toBe(before.repeat(24))
      }
    }
    expect(effects.map(event => event.id)).toEqual(incremental)
    expect(mounted()).toEqual(incremental)
    expect(slots.every(value => value === renderSlot)).toBe(true)
    expect(fallbacks.every(value => value === fallback)).toBe(true)
    for (const event of effects.slice(1)) {
      const before = incremental[incremental.indexOf(event.id) - 1]!
      expect(event.previous).toContainEqual([before, before.repeat(24)])
    }
  })

  it('queues first unseen settled results in the recovery frontier while history stays immediate', async () => {
    const first = call('a', 'a'.repeat(80), [call('b')])
    const second = { ...call('c'), kind: 'tool-result', result: 'ok' }
    const history = { ...call('old-a', 'history', [call('old-b', 'history')]), kind: 'tool-result', result: 'ok' }
    const view = render(createElement('main', null, seed()))
    await drain(30)
    await signal(true)
    view.rerender(createElement('main', null, item('history', 0, history, true, 0), seed(), item('first', 2, first), item('settled', 3, second, true)))
    await signal(false)
    await paint(3)
    expect(text('old-a')).toBe('history')
    expect(text('old-b')).toBe('history')
    expect(renders.has('c')).toBe(false)
    expect(document.querySelector('[data-tool-icon="c"]')).toBeNull()
    await drain(200)
    expect(text('c')).toBe(second.text)
    expect(effects.filter(event => !event.id.startsWith('old-')).map(event => event.id)).toEqual(['a', 'b', 'c'])
  })

  it.each([false, true])('creates an incrementally published completed result after live text drains (recovery=%s)', async recovering => {
    const first = call('a', 'a'.repeat(70))
    const completed = { ...call('b', 'b'.repeat(30), [call('c', 'c'.repeat(30))]), kind: 'tool-result', result: 'ok' }
    const view = render(createElement('main', null, item('first', 1, first)))
    await paint(3)
    expect(text('a')!.length).toBeGreaterThan(0)
    expect(text('a')!.length).toBeLessThan(first.text.length)
    if (recovering) await signal(true)
    view.rerender(createElement('main', null, item('first', 1, first), item('completed', 2, completed, true)))
    if (recovering) await signal(false)
    await paint(3)
    expect(renders.has('b')).toBe(false)
    expect(renders.has('c')).toBe(false)
    expect(mounted()).toEqual(['a'])
    await drain(200)
    expect(effects.map(event => event.id)).toEqual(['a', 'b', 'c'])
    expect(effects[1]!.previous).toContainEqual(['a', first.text])
    expect(effects[2]!.previous).toContainEqual(['b', completed.text])
  })

  it('advances icon-only calls one committed frame at a time and releases the next row', async () => {
    const root = call('a', '', [call('b', '', [call('c', '')]), call('d', '')])
    const view = render(createElement('main', null, item('tree', 2, root), item('later', 3, call('e', ''))))
    await act(async () => {})
    expect(mounted()).toEqual(['a'])
    let previous = 1
    for (let index = 0; index < 10; index++) {
      await paint()
      const current = view.container.querySelectorAll('svg').length
      expect(current - previous).toBeLessThanOrEqual(1)
      previous = current
    }
    expect(effects.map(event => event.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(frames.size).toBe(0)
  })

  it.each([true, false])('drains a single icon-only owner before creating the next row (known tree=%s)', async knownTree => {
    const IconOnly = wrapFollowNodeView(() => createElement('article',
      knownTree ? { 'data-chat-call-id': 'icon-only' } : {},
      createElement('svg', { 'data-testid': 'only-icon' })), () => false)
    const view = render(createElement('main', null,
      createElement('section', { key: 'icon', 'data-chat-flow-key': 'icon' }, createElement(IconOnly, {
        node: node('icon', 1, knownTree ? call('icon-only', '') : {}), sessionId: 'tool-creation',
      })),
      item('later', 2, call('later', 'next'))))
    await drain(40)
    expect(view.getByTestId('only-icon')).toBeTruthy()
    expect(text('later')).toBe('next')
    expect(view.container.querySelector('[data-chat-flow-key="icon"] [data-smooth-stream-phase]')
      ?.getAttribute('data-smooth-stream-phase')).toBe('settled')
    expect(streamRelay.isBlocked({ session: 'tool-creation', turn: '1', step: 1, node: 'tail', order: 3 }, 'output')).toBe(false)
    expect(frames.size).toBe(0)
  })

  it('drains an admitted renderer that returns no DOM before creating the next row', async () => {
    const Empty = wrapFollowNodeView(() => null, () => false)
    const view = render(createElement('main', null,
      createElement('section', { key: 'empty', 'data-chat-flow-key': 'empty' }, createElement(Empty, {
        node: node('empty', 1, {}), sessionId: 'tool-creation',
      })),
      item('later', 2, call('later', 'next'))))
    await drain(40)
    expect(text('later')).toBe('next')
    expect(view.container.querySelector('[data-chat-flow-key="empty"] [data-smooth-stream-phase]')
      ?.getAttribute('data-smooth-stream-phase')).toBe('settled')
    expect(frames.size).toBe(0)
  })

  it('restores the current text after a call replaces its Text node and is regrouped', async () => {
    const Replacement = wrapFollowNodeView(props => {
      const source = (props.node as { data: { root: Call } }).data.root
      return createElement('article', { 'data-chat-call-id': source.callId }, source.phase === 'preparing'
        ? createElement('span', { key: 'preparing', 'data-testid': 'replacement-text' }, source.text)
        : createElement('strong', { key: 'running', 'data-testid': 'replacement-text' }, source.text))
    }, () => false)
    const initial = { ...call('replace', 'initial summary '.repeat(4)), phase: 'preparing' }
    const replacement = { ...initial, phase: 'running', text: 'replacement summary '.repeat(4) }
    const tree = (group: string, root: Call) => createElement('main', null,
      createElement('div', { key: group }, createElement(Replacement, {
        node: node('replacement', 1, root), sessionId: 'tool-creation',
      })))
    const view = render(tree('first', initial))
    await drain(180)
    expect(view.getByTestId('replacement-text').textContent).toBe(initial.text)
    view.rerender(tree('first', replacement))
    await drain(180)
    expect(view.getByTestId('replacement-text').textContent).toBe(replacement.text)
    view.rerender(tree('second', replacement))
    expect(view.getByTestId('replacement-text').textContent).toBe(replacement.text)
    await paint(3)
    expect(view.getByTestId('replacement-text').textContent).toBe(replacement.text)
  })

  it('keeps projected calls in their frozen recovery epoch ahead of later source suffixes', async () => {
    const original = call('a', 'a'.repeat(50), [call('b', 'b'.repeat(50))])
    const view = render(createElement('main', null, seed(), item('tree', 2, original)))
    for (let index = 0; index < 30 && !renders.has('a'); index++) await paint()
    await paint(3)
    expect(renders.has('a')).toBe(true)
    expect(renders.has('b')).toBe(false)
    await signal(true)
    await signal(false)
    const suffix = { ...original, text: original.text + 'x'.repeat(50), subCalls: [
      { ...original.subCalls[0]!, text: original.subCalls[0]!.text + 'y'.repeat(50) }, call('c', 'c'.repeat(30)),
    ] }
    await act(async () => { view.rerender(createElement('main', null, seed(), item('tree', 2, suffix))) })
    for (let index = 0; index < 120 && !renders.has('b'); index++) await paint()
    expect(renders.has('b')).toBe(true)
    expect(text('a')).toBe(original.text)
    expect(streamRelay.recoveryEpoch('["tool-creation","1"]')).toBe(0)
    expect(renders.has('c')).toBe(false)
    for (let index = 0; index < 120 && streamRelay.recoveryEpoch('["tool-creation","1"]') === 0; index++) {
      await paint()
      if (streamRelay.recoveryEpoch('["tool-creation","1"]') === 0) {
        expect(text('a')).toBe(original.text)
        expect(original.subCalls[0]!.text.startsWith(text('b')!)).toBe(true)
      }
    }
    expect(text('b')).toBe(original.subCalls[0]!.text)
    await drain(160)
    expect(text('a')).toBe(suffix.text)
    expect(text('b')).toBe(suffix.subCalls[0]!.text)
    expect(text('c')).toBe('c'.repeat(30))
    expect(effects.map(event => event.id)).toEqual(['a', 'b', 'c'])
    expect(streamRelay.recoveryEpoch('["tool-creation","1"]')).toBeUndefined()
  })

  it('preserves an admitted Inner and hook state while later growth pauses it', async () => {
    const root = call('a', 'a'.repeat(60), [call('b')])
    const view = render(item('tree', 2, root))
    await paint(5)
    const button = view.container.querySelector<HTMLButtonElement>('button')!
    await act(async () => { button.click() })
    const before = text('a')
    let token: symbol
    await act(async () => { token = streamRelay.acquire({ session: 'tool-creation', turn: '1', step: 1, node: 'earlier', order: 1 }, 'response') })
    await paint(6)
    expect(view.container.querySelector('button')).toBe(button)
    expect(button.dataset.clicks).toBe('1')
    expect(text('a')).toBe(before)
    expect(renders.has('b')).toBe(false)
    expect(effects.map(event => event.id)).toEqual(['a'])
    await act(async () => { streamRelay.release(token!) })
    await drain()
    expect(button.dataset.clicks).toBe('1')
    expect(effects.map(event => event.id)).toEqual(['a', 'b'])
  })

  it('preserves an already-created sibling when an earlier subtree gains a call', async () => {
    const first = call('a', 'a'.repeat(12))
    const sibling = call('b', 'b'.repeat(100))
    const root = call('root', 'root', [first, sibling])
    const view = render(item('tree', 2, root))
    for (let index = 0; index < 120 && !renders.has('b'); index++) await paint()
    await paint(3)
    const before = text('b')!
    expect(before.length).toBeLessThan(sibling.text.length)
    const button = view.container.querySelector<HTMLButtonElement>('[aria-label="b"]')!
    const article = button.closest('article')!
    await act(async () => { button.click() })
    const inserted = { ...root, subCalls: [{ ...first, subCalls: [call('new', 'new'.repeat(12))] }, sibling] }
    await act(async () => { view.rerender(item('tree', 2, inserted)) })
    expect(view.container.querySelector('[aria-label="b"]')).toBe(button)
    expect(button.closest('article')).toBe(article)
    expect(button.dataset.clicks).toBe('1')
    expect(text('b')).toBe(before)
    expect(renders.has('new')).toBe(false)
    for (let index = 0; index < 200 && !renders.has('new'); index++) {
      await paint()
      expect(view.container.querySelector('[aria-label="b"]')).toBe(button)
    }
    expect(text('b')).toBe(sibling.text)
    await drain(100)
    expect(effects.map(event => event.id)).toEqual(['root', 'a', 'b', 'new'])
    expect(mounted()).toEqual(['root', 'a', 'new', 'b'])
    expect(button.dataset.clicks).toBe('1')
  })

  it('resumes a half-presented regrouped identity without creating its remaining calls', async () => {
    const root = call('a', 'a'.repeat(80), [call('b', 'b'.repeat(40)), call('c', 'c'.repeat(40))])
    const tree = (group: string) => createElement('main', null,
      createElement('div', { key: group }, item('tree', 2, root)))
    const view = render(tree('first-group'))
    await paint(5)
    const before = text('a')!
    expect(before.length).toBeGreaterThan(0)
    expect(before.length).toBeLessThan(root.text.length)
    expect(mounted()).toEqual(['a'])
    await act(async () => { view.rerender(tree('second-group')) })
    expect(text('a')).toBe(before)
    expect(mounted()).toEqual(['a'])
    expect(renders.has('b')).toBe(false)
    expect(renders.has('c')).toBe(false)
    await paint(3)
    expect(text('a')!.length).toBeLessThan(root.text.length)
    expect(mounted()).toEqual(['a'])
    await drain(240)
    expect(effects.map(event => event.id)).toEqual(['a', 'a', 'b', 'c'])
    expect(text('c')).toBe(root.subCalls[1]!.text)
  })

  it('restores an already-presented identity without replaying creation admission', async () => {
    const root = call('a', 'a'.repeat(24), [call('b', 'b'.repeat(24))])
    const view = render(item('tree', 2, root))
    await drain()
    view.unmount()
    const token = streamRelay.acquire({ session: 'tool-creation', turn: '1', step: 1, node: 'earlier', order: 1 }, 'response')
    const again = render(item('tree', 2, root))
    expect(again.container.querySelectorAll('svg')).toHaveLength(2)
    expect(text('a')).toBe(root.text)
    expect(text('b')).toBe(root.subCalls[0]!.text)
    expect(effects.map(event => event.id)).toEqual(['a', 'b', 'a', 'b'])
    streamRelay.release(token)
  })
})
