import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamRelay, streamRelay, relayTurnKey, type RelayScope } from '../src/client/streamRelay.ts'
import { wrapFollowNodeView, clearToolPresentationLedger } from '../src/client/TypewriterToolNodeView.tsx'

const scope = (node: string, order: number, recoveryEpoch?: number): RelayScope => ({
  session: 'recovery-batches', turn: '1', step: 1, node, order, recoveryEpoch,
})

describe('recovery batch relay ordering', () => {
  it('finishes a later root first batch before an earlier root second batch', () => {
    const relay = new StreamRelay()
    const laterA = scope('later', 20, 0)
    const earlierB = scope('earlier', 10, 1)
    const later = relay.acquire(laterA, 'tool')
    relay.acquire(earlierB, 'response')
    expect(relay.isBlocked(laterA, 'tool')).toBe(false)
    expect(relay.isBlocked(earlierB, 'response')).toBe(true)
    expect(relay.recoveryEpoch(relayTurnKey(earlierB))).toBe(0)
    relay.release(later)
    expect(relay.recoveryEpoch(earlierB)).toBe(1)
    expect(relay.isBlocked(earlierB, 'response')).toBe(false)
  })

  it('retains source ordering within each recovery batch', () => {
    const relay = new StreamRelay()
    const earlier = scope('earlier', 10, 2)
    const later = scope('later', 20, 2)
    const token = relay.acquire(earlier, 'response')
    relay.acquire(later, 'tool')
    expect(relay.isBlocked(later, 'tool')).toBe(true)
    relay.release(token)
    expect(relay.isBlocked(later, 'tool')).toBe(false)
  })

  it('keeps newly ordinary earlier input behind remaining recovery batches', () => {
    const relay = new StreamRelay()
    const ordinary = scope('earlier', 10)
    const recovery = scope('later', 20, 1)
    relay.acquire(ordinary, 'response')
    const token = relay.acquire(recovery, 'tool')
    expect(relay.isBlocked(ordinary, 'response')).toBe(true)
    expect(relay.isBlocked(recovery, 'tool')).toBe(false)
    relay.release(token)
    expect(relay.isBlocked(ordinary, 'response')).toBe(false)
    expect(relay.recoveryEpoch(ordinary)).toBeUndefined()
  })

  it('notifies batch promotion and isolates other turns and tool presence', () => {
    const relay = new StreamRelay()
    const later = scope('later', 20, 0)
    const earlier = scope('earlier', 10, 1)
    const token = relay.acquire(later, 'tool')
    const changed = vi.fn()
    relay.subscribeBlocked(earlier, 'response', changed)
    expect(relay.hasTool({ ...later, recoveryEpoch: 99 })).toBe(true)
    expect(relay.isBlocked({ ...earlier, turn: '2' }, 'response')).toBe(false)
    relay.release(token)
    expect(changed).toHaveBeenCalledOnce()
    expect(relay.hasTool(later)).toBe(false)
  })

  it('retains ordinary ordering when there are no recovery batches', () => {
    const relay = new StreamRelay()
    relay.acquire(scope('earlier', 10), 'response')
    expect(relay.isBlocked(scope('later', 20), 'tool')).toBe(true)
    expect(relay.isBlocked(scope('earlier', 10), 'response')).toBe(false)
  })
})

let frames: Map<number, FrameRequestCallback>
let time: number
let next: number
async function paint(count: number) {
  for (let index = 0; index < count; index++) await act(async () => {
    const batch = [...frames.values()]
    frames.clear()
    time += 16
    for (const callback of batch) callback(time)
  })
}
beforeEach(() => {
  frames = new Map(); time = 0; next = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = next++; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('performance', { now: () => time })
})
afterEach(() => { cleanup(); streamRelay.clearAll(); clearToolPresentationLedger(); vi.unstubAllGlobals() })

it('hands multiple recovered rows from epoch zero to epoch one without blocking the later first batch', async () => {
  const Row = wrapFollowNodeView(props => createElement('article', { 'data-row': props.id as string }, props.text as string), () => false)
  const node = (id: string, order: number) => ({ key: id, kind: 'tool-call', anchorSeq: order, data: { root: {}, turn: 1, step: 1 } })
  const tree = (a: string, b: string) => createElement('main', null,
    createElement(Row, { key: 'earlier', id: 'earlier', text: a, sessionId: 'recovery-batches', node: node('earlier', 10) }),
    createElement(Row, { key: 'later', id: 'later', text: b, sessionId: 'recovery-batches', node: node('later', 20) }))
  const view = render(tree('a', 'b'))
  await paint(30)
  await act(async () => { window.dispatchEvent(new Event('dsha:background')) })
  await act(async () => { view.rerender(tree('a'.repeat(20), 'b'.repeat(40))) })
  await act(async () => { window.dispatchEvent(new Event('dsha:foreground')) })
  await act(async () => { view.rerender(tree('a'.repeat(100), 'b'.repeat(40))) })
  const text = (id: string) => view.container.querySelector(`[data-row="${id}"]`)!.textContent!
  for (let index = 0; index < 100 && text('earlier').length < 20; index++) await paint(1)
  expect(text('earlier')).toBe('a'.repeat(20))
  expect(text('later').length).toBeLessThan(40)
  const earlierAtHandoff = text('earlier')
  let laterAdvanced = false
  for (let index = 0; index < 100 && text('later').length < 40; index++) {
    const before = text('later').length
    await paint(1)
    if (text('later').length > before) laterAdvanced = true
    if (text('later').length < 40) expect(text('earlier')).toBe(earlierAtHandoff)
  }
  expect(laterAdvanced).toBe(true)
  expect(text('later')).toBe('b'.repeat(40))
  await paint(200)
  expect(text('earlier')).toBe('a'.repeat(100))
  expect(streamRelay.recoveryEpoch(scope('earlier', 10))).toBeUndefined()
})

it('preserves an already visible row while another recovery batch pauses its playback', async () => {
  const Row = wrapFollowNodeView(props => createElement('article', null, props.text as string), () => false)
  const view = render(createElement(Row, { text: 'b'.repeat(120), sessionId: 'recovery-batches', node: {
    key: 'later', kind: 'tool-call', anchorSeq: 20, data: { root: {}, turn: 1, step: 1 },
  } }))
  await paint(6)
  const before = view.container.querySelector('article')!.textContent!
  expect(before.length).toBeGreaterThan(0)
  expect(before.length).toBeLessThan(120)
  let token: symbol
  await act(async () => { token = streamRelay.acquire(scope('earlier', 10, 0), 'response') })
  const wrapper = view.container.querySelector<HTMLElement>('[data-smooth-stream-phase]')!
  expect(wrapper.dataset.smoothStreamPhase).toBe('waiting')
  expect(wrapper.style.height).not.toBe('0px')
  expect(wrapper.style.opacity).not.toBe('0')
  await paint(4)
  expect(view.container.querySelector('article')!.textContent).toBe(before)
  await act(async () => { streamRelay.release(token!) })
  await paint(8)
  expect(view.container.querySelector('article')!.textContent!.length).toBeGreaterThan(before.length)
})
