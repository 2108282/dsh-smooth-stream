import { assistantProgress } from '../src/client/presentationProgress.ts'
import { clearToolPresentationLedger } from '../src/client/TypewriterToolNodeView.tsx'
import { act, cleanup, render } from '@testing-library/react'
import { createElement, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProgressiveDomText } from '../src/client/useProgressiveDomText.ts'
import { useSmoothStreamContent } from '../src/client/useSmoothStreamContent.ts'
import { wrapFollowNodeView } from '../src/client/TypewriterToolNodeView.tsx'
import { streamRelay } from '../src/client/streamRelay.ts'
import { installRecoverySynchronization, isBackgroundRecoveryScope, notifyRecoverySynchronized, setForegroundRecoveryDelay } from '../src/client/backgroundRecovery.ts'
import type { BackgroundRecovery } from '../src/settings.ts'

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
function Probe({ text, mode, complete = false, enabled = true, replayOnEnable = false, shouldHoldBack, recoveryKey, initialDisplayedContent, resumeOnMount }: {
  text: string
  mode: BackgroundRecovery
  complete?: boolean
  enabled?: boolean
  replayOnEnable?: boolean
  shouldHoldBack?: () => boolean
  recoveryKey?: string
  initialDisplayedContent?: string
  resumeOnMount?: boolean
}) {
  return createElement('output', null, useSmoothStreamContent(text, {
    backgroundRecovery: mode, inputComplete: complete, enabled, replayOnEnable, shouldHoldBack, recoveryKey, initialDisplayedContent, resumeOnMount,
  }))
}

function DomProbe({ text, pending, paused = false, recoveryKey }: {
  text: string
  pending: (value: boolean) => void
  paused?: boolean
  recoveryKey?: string
}) {
  const root = useRef<HTMLOutputElement>(null)
  const speed = useRef(35)
  useProgressiveDomText(root, true, true, speed, undefined, pending, paused, 'catch-up', recoveryKey)
  return createElement('output', { ref: root }, text)
}

describe('background snapshot synchronization', () => {
  it('does not leave animation work behind for hidden assistant snapshots', async () => {
    const view = render(createElement(Probe, { text: 'start', mode: 'catch-up' }))
    await paint(20)
    await background(true)
    for (const text of ['start' + 'x'.repeat(2000), 'replacement', 'latest 😀'.repeat(400)]) {
      view.rerender(createElement(Probe, { text, mode: 'catch-up' }))
      expect(frames.size).toBe(0)
    }
    await background(false)
    expect(view.container.textContent).toBe('latest 😀'.repeat(400))
    expect(frames.size).toBe(0)
  })

  it('does not enqueue hidden tool mutations, then paces new foreground text', async () => {
    const pending = vi.fn()
    const view = render(createElement(DomProbe, { text: 'start', pending }))
    await paint(20)
    await background(true)
    pending.mockClear()
    for (const text of ['start' + 'x'.repeat(2000), 'replacement', 'latest 😀'.repeat(40)]) {
      view.rerender(createElement(DomProbe, { text, pending }))
      await act(async () => {})
      expect(view.container.textContent).toBe(text)
      expect(frames.size).toBe(0)
    }
    expect(pending).not.toHaveBeenCalledWith(true)
    await background(false)
    const snapshot = view.container.textContent!
    const nextText = snapshot + 'n'.repeat(200)
    view.rerender(createElement(DomProbe, { text: nextText, pending }))
    await paint(3)
    expect(view.container.textContent!.length).toBeGreaterThan(snapshot.length)
    expect(view.container.textContent!.length).toBeLessThan(nextText.length)
  })

  it('synchronizes tool DOM after a baseline and its React commit share a publication', async () => {
    let syncing = true
    const stop = installRecoverySynchronization({ pending: () => syncing })
    const recoveryKey = '["tool-baseline",1]'
    const pending = vi.fn()
    try {
      const view = render(createElement(DomProbe, { text: 'start', pending, recoveryKey }))
      await paint(20)
      await background(true)
      await background(false)
      expect(isBackgroundRecoveryScope(recoveryKey)).toBe(true)
      const text = 'start' + 'x'.repeat(2000)
      await act(async () => {
        view.rerender(createElement(DomProbe, { text, pending, paused: true, recoveryKey }))
        syncing = false
        notifyRecoverySynchronized()
      })
      expect(view.container.textContent).toBe(text)
      expect(isBackgroundRecoveryScope(recoveryKey)).toBe(false)
      expect(frames.size).toBe(0)
    } finally { stop() }
  })

  it('retires a complete cached snapshot before the next foreground chunk', async () => {
    const props = { text: 'cached', initialDisplayedContent: 'cached', resumeOnMount: true, mode: 'catch-up' as const }
    const view = render(createElement(Probe, props))
    expect(view.container.textContent).toBe('cached')
    view.rerender(createElement(Probe, { ...props, text: 'cached' + 'n'.repeat(200) }))
    await paint(3)
    expect(view.container.textContent!.length).toBeGreaterThan(6)
    expect(view.container.textContent!.length).toBeLessThan(206)
  })

  it('consumes cached recovery once across inactive and active transitions', async () => {
    const props = { text: 'cached' + 'x'.repeat(200), initialDisplayedContent: 'cached', resumeOnMount: true, mode: 'catch-up' as const }
    const view = render(createElement(Probe, props))
    await paint(3)
    expect(view.container.textContent).toBe(props.text)
    view.rerender(createElement(Probe, { ...props, complete: true }))
    const nextText = props.text + 'n'.repeat(200)
    view.rerender(createElement(Probe, { ...props, text: nextText }))
    await paint(3)
    expect(view.container.textContent!.length).toBeGreaterThan(props.text.length)
    expect(view.container.textContent!.length).toBeLessThan(nextText.length)
  })

  it.each(['replay', 'catch-up', 'latest'] as const)('shows the complete received snapshot immediately on resume (%s)', async mode => {
    const view = render(createElement(Probe, { text: 'x'.repeat(100), mode }))
    await paint(3)
    const before = view.container.textContent!.length
    await background(true)
    view.rerender(createElement(Probe, { text: 'x'.repeat(2000), mode, complete: true }))
    expect(view.container.textContent!.length).toBe(before)
    await background(false)
    expect(view.container.textContent).toBe('x'.repeat(2000))

    view.rerender(createElement(Probe, { text: 'x'.repeat(2100), mode }))
    await paint(3)
    expect(view.container.textContent!.length).toBeGreaterThan(2000)
    expect(view.container.textContent!.length).toBeLessThan(2100)
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
    expect(view.container.textContent!.length).toBeLessThan(nextText.length)
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
    expect(view.container.textContent).toBe(hidden ? 'second' : 'first')

    hold = false
    await paint(10)
    expect(view.container.textContent).toBe('second')
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
      expect(view.container.textContent!.length).toBe(2003)
      await paint(2)
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
    expect(view.container.textContent!.length).toBeGreaterThan(3)
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
    await background(true)
    view.rerender(tree('x'.repeat(200)))
    await paint(10)
    expect(view.container.querySelector('[data-id="a"]')!.textContent).toBe('x'.repeat(200))
    await background(false)
    expect(view.container.querySelector('[data-id="a"]')!.textContent).toBe('x'.repeat(200))
    expect(view.container.querySelector('[data-id="b"]')!.textContent).toBe('x'.repeat(200))
  })

  it('synchronizes a complete snapshot including collapsed source ranges', async () => {
    const head = 'h'.repeat(20)
    const hidden = 'r'.repeat(2000)
    const tail = 't'.repeat(20)
    const Collapsed = ({ text }: { text: string }) => createElement('output', null, useSmoothStreamContent(text, {
      backgroundRecovery: 'catch-up',
      skipRanges: [[head.length, head.length + hidden.length]] as const,
      canSkipRange: () => true,
    }))
    const view = render(createElement(Collapsed, { text: '' }))
    await paint(3)
    await background(true)
    view.rerender(createElement(Collapsed, { text: head + hidden + tail }))
    await background(false)
    expect(view.container.textContent).toBe(head + hidden + tail)
  })
})
