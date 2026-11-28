import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSmoothStreamContent, type UseSmoothStreamContentOptions } from '../src/client/useSmoothStreamContent.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'

let frames: Map<number, FrameRequestCallback>
let time: number
let next: number
async function paint(count = 1, interval = 16) {
  for (let index = 0; index < count; index++) await act(async () => {
    const batch = [...frames.values()]
    frames.clear()
    time += interval
    for (const callback of batch) callback(time)
  })
}
function Probe({ text, ...options }: { text: string } & UseSmoothStreamContentOptions) {
  return createElement('output', null, useSmoothStreamContent(text, options))
}
beforeEach(() => {
  frames = new Map(); time = 0; next = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = next++; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('performance', { now: () => time })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ordinary playback across lifecycle signals', () => {
  it.each(['dsha:background', 'dsha:foreground', 'pagehide', 'pageshow', 'blur', 'focus', 'visibilitychange'])('does not pause or flush on %s', async (event: 'dsha:background' | 'dsha:foreground' | 'pagehide' | 'pageshow' | 'blur' | 'focus' | 'visibilitychange') => {
    const view = render(createElement(Probe, { text: 'x'.repeat(200) }))
    await paint(3)
    const before = view.container.textContent!.length
    await act(async () => { (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event)) })
    expect(frames.size).toBe(1)
    await paint()
    const added = view.container.textContent!.length - before
    expect(added).toBeGreaterThan(0)
    expect(added).toBeLessThanOrEqual(DEFAULT_STREAM_DEBUG_TUNING.cadenceClamp)
    expect(view.container.textContent!.length).toBeLessThan(200)
  })

  it.each([{}, { steadyCps: 120 }, { inputComplete: true }])('bounds stalled frame time for %j', async (options: { steadyCps?: number; inputComplete?: boolean }) => {
    const measure = async (interval: number) => {
      time = 0
      const view = render(createElement(Probe, { text: 'x'.repeat(2000), ...options }))
      await paint(3)
      const before = view.container.textContent!.length
      await paint(1, interval)
      const added = view.container.textContent!.length - before
      view.unmount()
      return added
    }
    const longGap = await measure(60000)
    if ('steadyCps' in options) {
      // Long idle time changes live vs settle velocity, but never earns more
      // than the ordinary 32ms settle budget.
      expect(longGap).toBeGreaterThan(0)
      expect(longGap).toBeLessThanOrEqual(Math.ceil(options.steadyCps! * 1.8 * 0.032))
    } else expect(longGap).toBe(await measure(32))
  })

  it('holds authoritative replacements behind the ordinary performance guard', async () => {
    let hold = false
    const shouldHoldBack = () => hold
    const view = render(createElement(Probe, { text: 'first', shouldHoldBack }))
    await paint(10)
    hold = true
    view.rerender(createElement(Probe, { text: 'superseded', shouldHoldBack }))
    view.rerender(createElement(Probe, { text: 'replacement😀', shouldHoldBack }))
    await paint(5)
    expect(view.container.textContent).toBe('first')
    hold = false
    await paint(30)
    expect(view.container.textContent).toBe('replacement😀')
  })

  it.each([true, false])('replays an enabled snapshot only when explicitly requested (%s)', async (replayOnEnable: boolean) => {
    const text = 'queued '.repeat(30)
    let hold = true
    const shouldHoldBack = () => hold
    const view = render(createElement(Probe, { text, enabled: false, replayOnEnable, shouldHoldBack }))
    expect(view.container.textContent).toBe(text)
    view.rerender(createElement(Probe, { text, replayOnEnable, shouldHoldBack }))
    await paint(5)
    expect(view.container.textContent).toBe(replayOnEnable ? '' : text)
    hold = false
    await paint(200)
    expect(view.container.textContent).toBe(text)
  })

  it('skips hidden details between visible ranges without spending their reveal budget', async () => {
    const head = 'h'.repeat(20)
    const hidden = 'r'.repeat(2000)
    const tail = 't'.repeat(20)
    const view = render(createElement(Probe, {
      text: head + hidden + tail,
      skipRanges: [[head.length, head.length + hidden.length]],
      canSkipRange: () => true,
    }))
    await paint(30)
    expect(view.container.textContent).toBe(head + hidden + tail)
    expect(frames.size).toBe(0)
  })
})
