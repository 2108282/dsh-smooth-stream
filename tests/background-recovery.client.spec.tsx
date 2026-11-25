import { assistantProgress } from '../src/client/presentationProgress.ts'
import { clearToolPresentationLedger } from '../src/client/TypewriterToolNodeView.tsx'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LARGE_RECOVERY_BACKLOG_CHARS, useSmoothStreamContent } from '../src/client/useSmoothStreamContent.ts'
import { wrapFollowNodeView } from '../src/client/TypewriterToolNodeView.tsx'
import { streamRelay } from '../src/client/streamRelay.ts'
import { installRecoverySynchronization, isBackgroundRecoveryScope, notifyRecoverySynchronized, recoveryBudget, RECOVERY_MAX_CHARS, setForegroundRecoveryDelay } from '../src/client/backgroundRecovery.ts'
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
  setForegroundRecoveryDelay(0)
})
afterEach(() => { cleanup(); setForegroundRecoveryDelay(0); assistantProgress.clear(); clearToolPresentationLedger(); streamRelay.clearAll(); vi.unstubAllGlobals() })
function Probe({ text, mode, complete = false, enabled = true, replayOnEnable = false, shouldHoldBack, onRecoveryBacklogChange, recoveryKey }: {
  text: string
  mode: BackgroundRecovery
  complete?: boolean
  enabled?: boolean
  replayOnEnable?: boolean
  shouldHoldBack?: () => boolean
  onRecoveryBacklogChange?: (pending: boolean) => void
  recoveryKey?: string
}) {
  return createElement('output', null, useSmoothStreamContent(text, {
    backgroundRecovery: mode, inputComplete: complete, enabled, replayOnEnable, shouldHoldBack, onRecoveryBacklogChange, recoveryKey,
  }))
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

  it.each([1000 / 120, 1000 / 60])('reveals catch-up on consecutive %sms frames without a 40ms gate', async interval => {
    const view = render(createElement(Probe, { text: 'x'.repeat(100), mode: 'catch-up' }))
    await paint(3)
    await background(true)
    view.rerender(createElement(Probe, { text: 'x'.repeat(1000), mode: 'catch-up', complete: true }))
    const before = view.container.textContent!.length
    await background(false)
    await paint(1, interval)
    expect(view.container.textContent!.length).toBe(before)
    for (let index = 0; index < 4; index++) {
      const previous = view.container.textContent!.length
      await paint(1, interval)
      const added = view.container.textContent!.length - previous
      expect(added).toBeGreaterThan(0)
      expect(added).toBeLessThanOrEqual(RECOVERY_MAX_CHARS)
    }
    await paint(500)
    expect(view.container.textContent).toBe('x'.repeat(1000))
    view.rerender(createElement(Probe, { text: 'x'.repeat(1100), mode: 'catch-up' }))
    await paint(3)
    expect(view.container.textContent!.length).toBeGreaterThan(1000)
    expect(view.container.textContent!.length).toBeLessThan(1100)
  })

  it('ignores focus recovery until native foreground arrives', async () => {
    setForegroundRecoveryDelay(500)
    const view = render(createElement(Probe, { text: 'start', mode: 'catch-up' }))
    await paint(10)
    await act(async () => { window.dispatchEvent(new Event('dsha:background')) })
    view.rerender(createElement(Probe, { text: 'start' + 'x'.repeat(100), mode: 'catch-up', complete: true }))
    const before = view.container.textContent
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await paint(5)
    expect(view.container.textContent).toBe(before)
    await act(async () => { window.dispatchEvent(new Event('dsha:foreground')) })
    await new Promise(resolve => setTimeout(resolve, 501))
    await paint(2)
    expect(view.container.textContent!.length).toBeGreaterThan(before!.length)
  })

  it('delays native foreground recovery and cancels it when hidden again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    setForegroundRecoveryDelay(500)
    const view = render(createElement(Probe, { text: 'start', mode: 'catch-up' }))
    await paint(10)
    await background(true)
    view.rerender(createElement(Probe, { text: 'start' + 'x'.repeat(100), mode: 'catch-up', complete: true }))
    const before = view.container.textContent
    await act(async () => { window.dispatchEvent(new Event('dsha:foreground')) })
    await vi.advanceTimersByTimeAsync(499)
    expect(view.container.textContent).toBe(before)
    await act(async () => { window.dispatchEvent(new Event('dsha:background')) })
    await vi.advanceTimersByTimeAsync(1000)
    expect(view.container.textContent).toBe(before)
    setForegroundRecoveryDelay(0)
    await act(async () => { window.dispatchEvent(new Event('dsha:foreground')) })
    await paint(2)
    expect(view.container.textContent!.length).toBeGreaterThan(before!.length)
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

  it.each(['replay', 'catch-up', 'latest'] as const)('does not replay a superseded replacement in %s mode', async mode => {
    const view = render(createElement(Probe, { text: 'first', mode }))
    await paint(10)
    await background(true)
    view.rerender(createElement(Probe, { text: 'second', mode }))
    expect(view.container.textContent).toBe('first')
    await background(false)
    view.rerender(createElement(Probe, { text: 'third', mode }))
    expect(view.container.textContent).toBe('third')

    view.rerender(createElement(Probe, { text: 'third!', mode }))
    await paint()
    expect(view.container.textContent).toBe('third')
    await paint(5)
    expect(view.container.textContent).toBe('third!')
  })

  it.each(['replay', 'catch-up', 'latest'] as const)('synchronizes disabled snapshots and resumes ordinary pacing in %s mode', async mode => {
    const view = render(createElement(Probe, { text: 'first', mode }))
    await paint(10)
    await background(true)
    view.rerender(createElement(Probe, { text: 'second', mode }))
    await background(false)
    view.rerender(createElement(Probe, { text: 'second!', mode, enabled: false }))
    expect(view.container.textContent).toBe('second!')

    const nextText = 'second!' + 'x'.repeat(100)
    view.rerender(createElement(Probe, { text: nextText, mode }))
    await paint()
    expect(view.container.textContent).toBe('second!')
    await paint(2)
    expect(view.container.textContent!.length).toBeGreaterThan('second!'.length)
    expect(view.container.textContent!.length).toBeLessThanOrEqual('second!'.length + 2 * DEFAULT_STREAM_DEBUG_TUNING.cadenceClamp)
    await paint(100)
    expect(view.container.textContent).toBe(nextText)
  })

  it.each([true, false])('replays a disabled snapshot on enable only when requested (%s)', async replayOnEnable => {
    const mode = 'replay'
    const text = 'queued '.repeat(30)
    let hold = true
    const shouldHoldBack = () => hold
    const view = render(createElement(Probe, { text, mode, enabled: false, replayOnEnable, shouldHoldBack }))
    expect(view.container.textContent).toBe(text)

    view.rerender(createElement(Probe, { text, mode, replayOnEnable, shouldHoldBack }))
    await paint(5)
    expect(view.container.textContent).toBe(replayOnEnable ? '' : text)
    hold = false
    await paint(3)
    if (replayOnEnable) {
      expect(view.container.textContent!.length).toBeGreaterThan(0)
      expect(view.container.textContent!.length).toBeLessThan(text.length)
    }
    await paint(200)
    expect(view.container.textContent).toBe(text)
    view.rerender(createElement(Probe, { text, mode, replayOnEnable, shouldHoldBack }))
    expect(view.container.textContent).toBe(text)
  })

  it.each([true, false])('holds a replacement behind its predecessor (background: %s)', async hidden => {
    const mode = 'latest'
    let hold = false
    const shouldHoldBack = () => hold
    const view = render(createElement(Probe, { text: 'first', mode, shouldHoldBack }))
    await paint(10)
    hold = true
    if (hidden) await background(true)
    view.rerender(createElement(Probe, { text: 'second', mode, shouldHoldBack }))
    if (hidden) await background(false)
    await paint(5)
    expect(view.container.textContent).toBe('first')

    hold = false
    await paint(10)
    expect(view.container.textContent).toBe('second')
  })

  it.each([LARGE_RECOVERY_BACKLOG_CHARS, LARGE_RECOVERY_BACKLOG_CHARS + 1])('reports only large recovery backlogs and holds the latch until drained (%s chars)', async backlog => {
    const mode = 'catch-up'
    const firstCallback = vi.fn()
    const latestCallback = vi.fn()
    const text = 'first' + 'x'.repeat(backlog)
    const view = render(createElement(Probe, { text: 'first', mode, onRecoveryBacklogChange: firstCallback }))
    await paint(10)
    await background(true)
    view.rerender(createElement(Probe, { text, mode, onRecoveryBacklogChange: firstCallback }))
    await background(false)
    expect(firstCallback.mock.calls).toEqual(backlog > LARGE_RECOVERY_BACKLOG_CHARS ? [[true]] : [])

    view.rerender(createElement(Probe, { text, mode, onRecoveryBacklogChange: latestCallback }))
    await paint(5)
    expect(view.container.textContent!.length).toBeGreaterThan('first'.length)
    expect(view.container.textContent!.length).toBeLessThan(text.length)
    expect(latestCallback).not.toHaveBeenCalled()
    await paint(400)
    expect(view.container.textContent).toBe(text)
    expect(latestCallback.mock.calls).toEqual(backlog > LARGE_RECOVERY_BACKLOG_CHARS ? [[false]] : [])
  })

  it.each([16, 60000])('does not report ordinary foreground backlog as a WebView resume (%sms frame)', async interval => {
    const onRecoveryBacklogChange = vi.fn()
    const view = render(createElement(Probe, {
      text: 'x'.repeat(LARGE_RECOVERY_BACKLOG_CHARS + 500), mode: 'replay', onRecoveryBacklogChange,
    }))
    await paint(3)
    await paint(1, interval)
    expect(onRecoveryBacklogChange).not.toHaveBeenCalled()
    expect(view.container.textContent!.length).toBeLessThan(LARGE_RECOVERY_BACKLOG_CHARS)
  })

  it.each(['replay', 'catch-up', 'latest'] as const)('retains %s for delayed synchronization data, then exits once drained', async mode => {
    let syncing = true
    const stop = installRecoverySynchronization({ pending: () => syncing })
    const recoveryKey = '["delayed",1]'
    try {
      const view = render(createElement(Probe, { text: 'abc', mode, recoveryKey }))
      await paint(30)
      await background(true)
      await background(false)
      await paint(3)
      expect(isBackgroundRecoveryScope(recoveryKey)).toBe(true)
      view.rerender(createElement(Probe, { text: 'abc' + 'x'.repeat(2000), mode, complete: true, recoveryKey }))
      syncing = false
      await act(async () => { notifyRecoverySynchronized() })
      await paint(5)
      if (mode === 'latest') expect(view.container.textContent!.length).toBe(2003)
      else expect(view.container.textContent!.length).toBeLessThanOrEqual(3 + (mode === 'replay' ? 20 : 5 * RECOVERY_MAX_CHARS))
      await paint(700)
      expect(view.container.textContent!.length).toBe(2003)
      expect(isBackgroundRecoveryScope(recoveryKey)).toBe(false)
    } finally { stop() }
  })

  it.each(['replay', 'catch-up', 'latest'] as const)('does not treat future foreground text as %s recovery after an empty synchronized resume', async mode => {
    const recoveryKey = '["empty",1]'
    const view = render(createElement(Probe, { text: 'abc', mode, recoveryKey }))
    await paint(30)
    await background(true)
    await background(false)
    await paint(3)
    expect(isBackgroundRecoveryScope(recoveryKey)).toBe(false)
    time += 30000
    view.rerender(createElement(Probe, { text: 'abc' + 'x'.repeat(1000), mode, complete: true, recoveryKey }))
    await paint(10)
    expect(view.container.textContent!.length).toBeGreaterThan(3 + 10 * RECOVERY_MAX_CHARS)
    expect(view.container.textContent!.length).toBeLessThan(1003)
    await paint(30)
    expect(view.container.textContent!.length).toBe(1003)
  })

  it('retires an empty queue on synchronization completion even without another text chunk', async () => {
    let syncing = true
    const stop = installRecoverySynchronization({ pending: () => syncing })
    const recoveryKey = '["unchanged",1]'
    try {
      render(createElement(Probe, { text: 'abc', mode: 'catch-up', recoveryKey }))
      await paint(30)
      await background(true)
      await background(false)
      await paint(3)
      expect(isBackgroundRecoveryScope(recoveryKey)).toBe(true)
      syncing = false
      await act(async () => { notifyRecoverySynchronized() })
      await paint(2)
      expect(isBackgroundRecoveryScope(recoveryKey)).toBe(false)
    } finally { stop() }
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

  it('counts only visible text when a collapsed range sits between visible text', async () => {
    // Visible prefix, a long collapsed reasoning range, then a visible tail.
    // While the cursor is still inside the prefix the collapsed range has not
    // been fast-forwarded yet; it is hidden text and must not inflate the
    // backlog past the large-recovery threshold.
    const head = 'h'.repeat(20)
    const hidden = 'r'.repeat(2000)
    const tail = 't'.repeat(20)
    const onRecoveryBacklogChange = vi.fn()
    const Collapsed = ({ text }: { text: string }) => createElement('output', null, useSmoothStreamContent(text, {
      backgroundRecovery: 'catch-up',
      onRecoveryBacklogChange,
      skipRanges: [[head.length, head.length + hidden.length]] as const,
      canSkipRange: () => true,
    }))
    const view = render(createElement(Collapsed, { text: '' }))
    await paint(3)
    await background(true)
    view.rerender(createElement(Collapsed, { text: head + hidden + tail }))
    await background(false)
    await paint(2)
    // Only 40 characters are visible, so no large backlog may be reported.
    expect(onRecoveryBacklogChange).not.toHaveBeenCalledWith(true)
    await paint(2000)
    expect(view.container.textContent).toBe(head + hidden + tail)
  })
})
