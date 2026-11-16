import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSmoothStreamContent } from '../src/client/useSmoothStreamContent.ts'
import { wrapFollowNodeView } from '../src/client/TypewriterToolNodeView.tsx'
import { streamRelay } from '../src/client/streamRelay.ts'
import { recoveryBudget, RECOVERY_MAX_CHARS } from '../src/client/backgroundRecovery.ts'
import { DEFAULT_STREAM_DEBUG_TUNING, type BackgroundRecovery } from '../src/settings.ts'

let frames: Map<number, FrameRequestCallback>
let time: number
let next: number
async function paint(count = 1, interval = 16) {
  for (let index = 0; index < count; index++) await act(async () => {
    const batch = [...frames.values()]; frames.clear(); time += interval
    for (const callback of batch) callback(time)
  })
}
async function background(hidden: boolean) {
  await act(async () => window.dispatchEvent(new Event(hidden ? 'dsha:background' : 'dsha:foreground')))
}
beforeEach(() => {
  frames = new Map(); time = 0; next = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = next++; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('performance', { now: () => time })
})
afterEach(() => { cleanup(); streamRelay.clearAll(); vi.unstubAllGlobals() })
function Probe({ text, mode, complete = false }: { text: string; mode: BackgroundRecovery; complete?: boolean }) {
  return createElement('output', null, useSmoothStreamContent(text, { backgroundRecovery: mode, inputComplete: complete }))
}

describe('background playback choices', () => {
  it('replays at ordinary per-frame budgets even if the producer completed in the background', async () => {
    const view = render(createElement(Probe, { text: 'x'.repeat(100), mode: 'replay' }))
    await paint(3)
    const before = view.container.textContent!.length
    await background(true)
    view.rerender(createElement(Probe, { text: 'x'.repeat(2000), mode: 'replay', complete: true }))
    await paint(10)
    expect(view.container.textContent!.length).toBe(before)
    time += 60000
    await background(false)
    await paint(5)
    const added = view.container.textContent!.length - before
    expect(added).toBeGreaterThan(0)
    expect(added).toBeLessThanOrEqual(5 * DEFAULT_STREAM_DEBUG_TUNING.cadenceClamp)
  })

  it('limits catch-up to one bounded commit per 40ms and resumes new live text normally', async () => {
    const view = render(createElement(Probe, { text: 'x'.repeat(100), mode: 'catch-up' }))
    await paint(3)
    await background(true)
    view.rerender(createElement(Probe, { text: 'x'.repeat(1000), mode: 'catch-up', complete: true }))
    const before = view.container.textContent!.length
    await background(false)
    await paint(3)
    expect(view.container.textContent!.length).toBe(before)
    await paint()
    expect(view.container.textContent!.length - before).toBeLessThanOrEqual(RECOVERY_MAX_CHARS)
    expect(view.container.textContent!.length).toBeGreaterThan(before)
    await paint(500)
    expect(view.container.textContent).toBe('x'.repeat(1000))
    view.rerender(createElement(Probe, { text: 'x'.repeat(1100), mode: 'catch-up' }))
    await paint(3)
    expect(view.container.textContent!.length).toBeGreaterThan(1000)
    expect(view.container.textContent!.length).toBeLessThan(1100)
  })

  it('shows latest on resume then paces later chunks, with repeated foreground signals idempotent', async () => {
    const view = render(createElement(Probe, { text: 'abc', mode: 'latest' }))
    await paint(20)
    await background(true)
    view.rerender(createElement(Probe, { text: 'x'.repeat(1000), mode: 'latest' }))
    await background(false)
    await paint(2)
    expect(view.container.textContent).toBe('x'.repeat(1000))
    await background(false)
    view.rerender(createElement(Probe, { text: 'x'.repeat(1100), mode: 'latest' }))
    await paint(3)
    expect(view.container.textContent!.length).toBeGreaterThan(1000)
    expect(view.container.textContent!.length).toBeLessThan(1100)
  })

  it.each(['replay', 'catch-up', 'latest'] as const)('retains %s when data arrives after the foreground callback', async mode => {
    const view = render(createElement(Probe, { text: 'abc', mode }))
    await paint(30)
    await background(true)
    await background(false)
    await paint(3)
    view.rerender(createElement(Probe, { text: 'abc' + 'x'.repeat(2000), mode, complete: true }))
    await paint(5)
    if (mode === 'latest') expect(view.container.textContent!.length).toBe(2003)
    else expect(view.container.textContent!.length).toBeLessThanOrEqual(3 + (mode === 'replay' ? 20 : 32))
  })

  it('falls back to a long RAF gap when a WebView omits visibility events', async () => {
    const view = render(createElement(Probe, { text: 'x'.repeat(2000), mode: 'latest' }))
    await paint(3)
    await paint(1, 60000)
    expect(view.container.textContent).toBe('x'.repeat(2000))
  })

  it.each(['replay', 'catch-up', 'latest'] as const)('applies %s to ordered generic output', async mode => {
    const Row = wrapFollowNodeView(props => createElement('article', { 'data-id': props.id }, props.text as string), () => false, () => mode)
    const item = (id: string, order: number, text: string) => createElement(Row, { key: id, id, text, sessionId: 's', node: {
      key: id, kind: 'tool-call', anchorSeq: order, data: { turn: 1, step: 1, root: {} },
    } })
    const tree = (text: string) => createElement('main', null, item('a', 1, text), item('b', 2, text))
    const view = render(tree('x'.repeat(100)))
    await paint(3)
    const before = view.container.querySelector('[data-id="a"]')!.textContent!.length
    await background(true)
    view.rerender(tree('x'.repeat(200)))
    await paint(10)
    expect(view.container.querySelector('[data-id="a"]')!.textContent!.length).toBe(before)
    await background(false)
    await paint(2)
    if (mode === 'latest') expect(view.container.querySelector('[data-id="a"]')!.textContent).toBe('x'.repeat(200))
    else expect(view.container.querySelector('[data-id="b"]')!.textContent).toBe('')
    await paint(300)
    expect(view.container.querySelector('[data-id="b"]')!.textContent).toBe('x'.repeat(200))
  })

  it('caps even a minute-long catch-up interval', () => {
    expect(recoveryBudget(10000, 60000, 0, DEFAULT_STREAM_DEBUG_TUNING).chars).toBeLessThanOrEqual(RECOVERY_MAX_CHARS)
  })
})
