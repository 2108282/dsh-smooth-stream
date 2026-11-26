import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debugRuntime } from '../src/client/debugRuntime.ts'
import { setForegroundRecoveryDelay } from '../src/client/backgroundRecovery.ts'
import { notifyFollowCommit, useConversationFollow } from '../src/client/teleprompterGlide.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'

const ORIGINAL = { padding: '13px', margin: '7px', minHeight: '29px', spacer: '48px' }
const pixels = (value: string): number => [...value.matchAll(/(-?[\d.]+)px/g)]
  .reduce((sum, match) => sum + Number(match[1]), 0)
const shift = (element: HTMLElement): number => Number(
  /translate3d\(0(?:px)?,\s*(-?[\d.]+)px,\s*0(?:px)?\)/.exec(element.style.transform)?.[1] ?? 0,
)
interface Layout {
  port: HTMLElement
  transcript: HTMLElement
  row: HTMLElement
  status: HTMLElement
  spacer: HTMLElement
  base: number
  viewport: number
  measurable: boolean
}
let time: number
let nextFrame: number
let frames: Map<number, FrameRequestCallback>

function Arm({ active = true, controlScroll = true }: { active?: boolean; controlScroll?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const speed = useRef(600)
  useConversationFollow(root, active, speed, undefined, true, false, undefined, undefined, undefined, undefined, controlScroll)
  return <div ref={root}>A live answer</div>
}
function Conversation({ layout, generation = 0, active = true, controlScroll = true }: {
  layout: { current: Layout | null }
  generation?: number
  active?: boolean
  controlScroll?: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const port = root.current!
    const transcript = port.querySelector<HTMLElement>('[data-chat-transcript]')!
    const row = port.querySelector<HTMLElement>('[data-chat-anchor-key]')!
    const status = port.querySelector<HTMLElement>('[data-chat-turn-status]')!
    const spacer = port.querySelector<HTMLElement>('[data-chat-turn-spacer]')!
    const model: Layout = { port, transcript, row, status, spacer, base: 800, viewport: 200, measurable: true }
    layout.current = model
    const height = () => model.base + pixels(transcript.style.paddingBottom)
      + pixels(status.style.marginTop) + pixels(spacer.style.height)
    let top = height() - model.viewport
    Object.defineProperty(port, 'clientHeight', { configurable: true, get: () => model.measurable ? model.viewport : 0 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: height })
    Object.defineProperty(port, 'scrollTop', {
      configurable: true,
      get: () => {
        top = Math.max(0, Math.min(top, height() - model.viewport))
        return top
      },
      set: value => { top = Math.max(0, Math.min(Number(value), height() - model.viewport)) },
    })
    // A browser smooth scroll owns its own RAF until an instant scrollTo
    // cancels it. Setting scrollTop alone need not cancel a queued host frame.
    let smoothFrame: number | null = null
    port.scrollTo = ((options: ScrollToOptions | number, y?: number) => {
      if (smoothFrame !== null) cancelAnimationFrame(smoothFrame)
      smoothFrame = null
      const target = typeof options === 'number' ? y ?? 0 : options.top ?? port.scrollTop
      if (typeof options === 'number' || options.behavior !== 'smooth') {
        port.scrollTop = target
        return
      }
      const tick = (): void => {
        port.scrollTop += Math.sign(target - port.scrollTop) * Math.min(4, Math.abs(target - port.scrollTop))
        fireEvent.scroll(port)
        if (smoothFrame !== null && Math.abs(target - port.scrollTop) > 0.01) smoothFrame = requestAnimationFrame(tick)
        else smoothFrame = null
      }
      smoothFrame = requestAnimationFrame(tick)
    }) as typeof port.scrollTo
    vi.spyOn(port, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, bottom: model.viewport, height: model.viewport }) as DOMRect)
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
      const bottom = model.base - port.scrollTop + shift(transcript) + shift(row)
      return { top: bottom - 40, bottom, height: 40 } as DOMRect
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => {
      const bottom = model.base + pixels(transcript.style.paddingBottom) - port.scrollTop + shift(transcript)
      return { top: -port.scrollTop + shift(transcript), bottom, height: model.base + pixels(transcript.style.paddingBottom) } as DOMRect
    })
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const top = model.base + pixels(status.style.marginTop) - port.scrollTop + shift(transcript)
      return model.measurable ? { top, bottom: top + 20, height: 20 } as DOMRect : { top: 0, bottom: 0, height: 0 } as DOMRect
    })
  }, [layout])
  return <div ref={root} data-conversation-scroll>
    <div data-chat-transcript style={{ paddingBottom: ORIGINAL.padding, minHeight: ORIGINAL.minHeight }}>
      <div data-chat-anchor-key="answer"><Arm key={generation} active={active} controlScroll={controlScroll} /></div>
      <div data-chat-turn-status role="status" style={{ marginTop: ORIGINAL.margin }}>Working</div>
    </div>
    <div data-chat-turn-spacer style={{ height: ORIGINAL.spacer }} />
  </div>
}
function mount() {
  const layout = { current: null as Layout | null }
  const view = render(<Conversation layout={layout} />)
  return {
    model: layout.current!,
    remount: () => view.rerender(<Conversation layout={layout} generation={1} />),
    complete: () => view.rerender(<Conversation layout={layout} active={false} />),
    disableControl: () => view.rerender(<Conversation layout={layout} controlScroll={false} />),
  }
}
async function paintElapsed(elapsedMs: number, observe?: () => void) {
  let remaining = elapsedMs
  while (remaining > 0) {
    const delta = Math.min(16, remaining)
    await act(async () => {
      time += delta
      await vi.advanceTimersByTimeAsync(delta)
      const batch = [...frames.values()]
      frames.clear()
      for (const callback of batch) callback(time)
    })
    observe?.()
    remaining -= delta
  }
}
function observeLayoutChanges(): () => void {
  const callbacks = new Set<ResizeObserverCallback>()
  class Observer {
    constructor(private callback: ResizeObserverCallback) { callbacks.add(callback) }
    observe() {}
    unobserve() {}
    disconnect() { callbacks.delete(this.callback) }
  }
  vi.stubGlobal('ResizeObserver', Observer)
  return () => {
    for (const callback of [...callbacks]) callback([], {} as ResizeObserver)
  }
}
function readingPosition(model: Layout) {
  return { top: model.port.scrollTop, anchorY: model.row.getBoundingClientRect().top }
}
async function paint(count = 1) {
  for (let index = 0; index < count; index++) await act(async () => {
    time += 16
    const batch = [...frames.values()]
    frames.clear()
    for (const callback of batch) callback(time)
  })
}
async function lifecycle(hidden: boolean) {
  await act(async () => window.dispatchEvent(new Event(hidden ? 'dsha:background' : 'dsha:foreground')))
}
function expectNativeSpacing(model: Layout) {
  expect(model.status.style.marginTop).toBe(ORIGINAL.margin)
  expect(model.transcript.style.paddingBottom).toBe(ORIGINAL.padding)
  expect(model.spacer.style.height).toBe(ORIGINAL.spacer)
}
beforeEach(() => {
  time = 0
  nextFrame = 0
  frames = new Map()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.stubGlobal('performance', { now: () => time })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  setForegroundRecoveryDelay(0)
  debugRuntime.resetRuntime()
  debugRuntime.syncSettings({
    enabled: false, tuningEnabled: true, writable: true, dirty: false, status: 'ready',
    tuning: { ...DEFAULT_STREAM_DEBUG_TUNING, runwayPx: 72, reserveResponseMs: 350 },
  })
})
afterEach(() => {
  cleanup()
  setForegroundRecoveryDelay(0)
  debugRuntime.resetRuntime()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('conversation follow across WebView recovery', () => {
  it('keeps the held viewport extent and reading anchor across synchronous remount during foreground waiting', async () => {
    const resize = observeLayoutChanges()
    setForegroundRecoveryDelay(5000)
    const { model, remount } = mount()
    await paint(20)
    await lifecycle(true)
    await lifecycle(false)
    const anchorY = model.row.getBoundingClientRect().top
    const originalPad = pixels(model.transcript.style.paddingBottom)
    await act(async () => {
      model.viewport += 24
      resize()
    })
    await paintElapsed(16)
    expect(model.row.getBoundingClientRect().top).toBeCloseTo(anchorY, 5)
    expect(pixels(model.transcript.style.paddingBottom) - originalPad).toBeCloseTo(24, 5)
    remount()
    expect(model.row.getBoundingClientRect().top).toBeCloseTo(anchorY, 5)
    await paintElapsed(160, () => {
      expect(model.row.getBoundingClientRect().top).toBeCloseTo(anchorY, 5)
      expect(pixels(model.transcript.style.paddingBottom) - originalPad).toBeCloseTo(24, 5)
    })
    await paintElapsed(4823)
    expect(model.row.getBoundingClientRect().top).toBeCloseTo(anchorY, 5)
    await paintElapsed(1)
    await paintElapsed(160)
    expect(model.port.scrollTop).toBe(model.port.scrollHeight - model.viewport)
  })

  it('keeps an already released reader at the compensated anchor after the foreground deadline', async () => {
    const resize = observeLayoutChanges()
    setForegroundRecoveryDelay(5000)
    const { model } = mount()
    await paint(20)
    await act(async () => {
      fireEvent.wheel(model.port, { deltaY: -80 })
      model.port.scrollTop = 300
      fireEvent.scroll(model.port)
    })
    await paint(3)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
    await lifecycle(true)
    await lifecycle(false)
    const anchorY = model.row.getBoundingClientRect().top
    const before = model.port.scrollTop
    await act(async () => {
      model.base += 48
      resize()
      notifyFollowCommit(model.row)
    })
    await paintElapsed(16)
    expect(model.row.getBoundingClientRect().top).toBeCloseTo(anchorY, 5)
    expect(model.port.scrollTop).toBeCloseTo(before + 48, 5)
    const compensatedTop = model.port.scrollTop
    await paintElapsed(4983, () => {
      expect(model.row.getBoundingClientRect().top).toBeCloseTo(anchorY, 5)
      expect(model.port.scrollTop).toBe(compensatedTop)
    })
    await paintElapsed(1)
    await paintElapsed(160)
    expect(model.row.getBoundingClientRect().top).toBeCloseTo(anchorY, 5)
    expect(model.port.scrollTop).toBe(compensatedTop)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
  })

  it.each(['touch-tap', 'pointer-click'] as const)('keeps the foreground freeze after a %s without scrolling', async gesture => {
    setForegroundRecoveryDelay(5000)
    const { model } = mount()
    await paint(20)
    await lifecycle(true)
    model.base += 160
    await lifecycle(false)
    const held = readingPosition(model)
    await act(async () => {
      if (gesture === 'touch-tap') {
        fireEvent.touchStart(model.row, { touches: [{ clientY: 100 }] })
        fireEvent.touchEnd(model.row, { touches: [] })
      } else {
        fireEvent.pointerDown(model.row)
        fireEvent.pointerUp(model.row)
        fireEvent.click(model.row)
      }
      model.port.scrollTop += 12
      fireEvent.scroll(model.port)
    })
    expect(readingPosition(model)).toEqual(held)
    await paintElapsed(160, () => expect(readingPosition(model)).toEqual(held))
    await paintElapsed(4839)
    expect(readingPosition(model)).toEqual(held)
    await paintElapsed(1)
    await paintElapsed(160)
    expect(model.port.scrollTop).toBe(model.port.scrollHeight - model.viewport)
    expect(model.port.scrollTop).toBeGreaterThan(held.top)
  })

  it('preserves a wheel-released reader across synchronous remount and subsequent scrolls without a new gesture', async () => {
    setForegroundRecoveryDelay(5000)
    const { model, remount } = mount()
    await paint(20)
    await lifecycle(true)
    model.base += 160
    await lifecycle(false)
    const before = model.port.scrollTop
    await act(async () => {
      fireEvent.wheel(model.port, { deltaY: -80 })
      model.port.scrollTop = before - 80
      fireEvent.scroll(model.port)
    })
    expect(model.port.scrollTop).toBe(before - 80)
    remount()
    // Momentum and accessibility scrolling may keep producing scroll events
    // after a renderer arm swaps, without another wheel/touchstart event.
    const readerTop = before - 120
    await act(async () => {
      model.port.scrollTop = readerTop
      fireEvent.scroll(model.port)
    })
    expect(model.port.scrollTop).toBe(readerTop)
    await paintElapsed(4999)
    expect(model.port.scrollTop).toBe(readerTop)
    await paintElapsed(1)
    await paintElapsed(160)
    expect(model.port.scrollTop).toBe(readerTop)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
  })

  it.each(['resize', 'commit'] as const)('corrects a late host RAF layout through the %s prepaint channel during foreground waiting', async channel => {
    const resize = observeLayoutChanges()
    setForegroundRecoveryDelay(5000)
    const { model } = mount()
    await paint(20)
    await lifecycle(true)
    await lifecycle(false)
    const anchorY = model.row.getBoundingClientRect().top
    // This callback is queued after the hold RAF, so polling the next frame
    // cannot hide a one-frame jump. A native RO delivery or reveal commit
    // must compensate in this same prepaint transaction.
    requestAnimationFrame(() => {
      model.base += 48
      if (channel === 'resize') resize()
      else notifyFollowCommit(model.row)
    })
    await paintElapsed(16)
    expect(model.row.getBoundingClientRect().top).toBeCloseTo(anchorY, 5)
    await paintElapsed(160, () => expect(model.row.getBoundingClientRect().top).toBeCloseTo(anchorY, 5))
  })

  it('freezes the foreground reading position against host smooth and bottom follow for exactly 5000ms', async () => {
    setForegroundRecoveryDelay(5000)
    const { model } = mount()
    await paint(20)
    await lifecycle(true)
    // Host results may grow while text playback is suspended. Leave room for
    // an independent host scroll to move, so a bottom clamp cannot pass this.
    model.base += 160
    const before = readingPosition(model)
    model.port.scrollTo({ top: model.port.scrollHeight - model.viewport, behavior: 'smooth' })
    await lifecycle(false)
    expect(readingPosition(model)).toEqual(before)
    await paintElapsed(160, () => expect(readingPosition(model)).toEqual(before))
    // A host RAF may also write scrollTop directly after the native smooth
    // animation has been canceled; both writers must obey the same freeze.
    for (let index = 0; index < 10; index++) {
      await act(async () => {
        model.port.scrollTop += 4
        fireEvent.scroll(model.port)
      })
      await paintElapsed(16)
      expect(readingPosition(model)).toEqual(before)
    }
    await paintElapsed(4679, () => expect(readingPosition(model)).toEqual(before))
    expect(model.row.textContent).toBe('A live answer')
    await paintElapsed(1)
    await paintElapsed(160)
    expect(model.port.scrollTop).toBe(model.port.scrollHeight - model.viewport)
    expect(model.port.scrollTop).toBeGreaterThan(before.top)
  })

  it('holds the screen anchor through content and viewport layout changes during the foreground delay', async () => {
    const resize = observeLayoutChanges()
    setForegroundRecoveryDelay(5000)
    const { model } = mount()
    await paint(20)
    await lifecycle(true)
    await lifecycle(false)
    const anchorY = model.row.getBoundingClientRect().top
    await act(async () => {
      model.base += 48
      model.viewport += 24
      resize()
      notifyFollowCommit(model.row)
    })
    await paintElapsed(32)
    expect(model.row.getBoundingClientRect().top).toBeCloseTo(anchorY, 5)
    const held = readingPosition(model)
    await paintElapsed(4967, () => {
      expect(model.row.getBoundingClientRect().top).toBeCloseTo(anchorY, 5)
      expect(model.port.scrollTop).toBe(held.top)
    })
    await paintElapsed(1)
    await paintElapsed(160)
    expect(model.port.scrollTop).toBe(model.port.scrollHeight - model.viewport)
  })

  it.each(['wheel', 'touchmove'] as const)('lets a %s reader gesture release the delayed freeze and never repins at its deadline', async gesture => {
    setForegroundRecoveryDelay(5000)
    const { model } = mount()
    await paint(20)
    await lifecycle(true)
    model.base += 160
    await lifecycle(false)
    await paintElapsed(100)
    const before = model.port.scrollTop
    await act(async () => {
      if (gesture === 'wheel') fireEvent.wheel(model.port, { deltaY: -80 })
      else {
        fireEvent.touchStart(model.port, { touches: [{ clientY: 100 }] })
        fireEvent.touchMove(model.port, { touches: [{ clientY: 150 }] })
      }
      model.port.scrollTop = before - 80
      fireEvent.scroll(model.port)
    })
    expect(model.port.scrollTop).toBe(before - 80)
    if (gesture === 'touchmove') fireEvent.touchEnd(model.port, { touches: [] })
    await paintElapsed(4899)
    const readerTop = model.port.scrollTop
    expect(readerTop).toBe(before - 80)
    await paintElapsed(1)
    await paintElapsed(160)
    expect(model.port.scrollTop).toBe(readerTop)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
  })

  it('cancels the old delay on a second background transition and freezes a remounted arm until the new deadline', async () => {
    setForegroundRecoveryDelay(5000)
    const { model, remount } = mount()
    await paint(20)
    await lifecycle(true)
    model.base += 80
    await lifecycle(false)
    await paintElapsed(2000)
    await lifecycle(true)
    model.base += 80
    await lifecycle(false)
    const held = readingPosition(model)
    remount()
    await paintElapsed(3000, () => expect(readingPosition(model)).toEqual(held))
    // The first foreground's deadline has passed, but the replacement delay
    // still owns this same port and must reject a fresh host follow write.
    await act(async () => {
      model.port.scrollTop += 4
      fireEvent.scroll(model.port)
    })
    expect(readingPosition(model)).toEqual(held)
    await paintElapsed(1999, () => expect(readingPosition(model)).toEqual(held))
    await paintElapsed(1)
    await paintElapsed(160)
    expect(model.port.scrollTop).toBe(model.port.scrollHeight - model.viewport)
    expect(model.port.scrollTop).toBeGreaterThan(held.top)
  })

  it('releases the delayed freeze immediately when scroll control is disabled', async () => {
    setForegroundRecoveryDelay(5000)
    const { model, disableControl } = mount()
    await paint(20)
    await lifecycle(true)
    model.base += 160
    await lifecycle(false)
    await paintElapsed(100)
    const before = model.port.scrollTop
    disableControl()
    const hostTop = before + 40
    await act(async () => {
      model.port.scrollTop = hostTop
      fireEvent.scroll(model.port)
    })
    await paintElapsed(6000)
    expect(model.port.scrollTop).toBe(hostTop)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
    expectNativeSpacing(model)
  })

  it.each([false, true])('does not recreate runway when a new arm mounts after host handoff (background=%s)', async background => {
    const { model, remount } = mount()
    await paint(20)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(true)
    for (let index = 0; index < 3; index++) {
      model.port.scrollTop = model.port.scrollHeight - model.port.clientHeight - 10
      await paint()
    }
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
    expectNativeSpacing(model)
    if (background) {
      await lifecycle(true)
      time += 60000
      await lifecycle(false)
    }
    model.port.scrollTop = model.port.scrollHeight - model.port.clientHeight
    remount()
    await paint()
    expectNativeSpacing(model)
    expect(shift(model.transcript)).toBe(0)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
    await paint(30)
    expectNativeSpacing(model)
  })

  it('releases obsolete geometry while hidden and remeasures the new viewport before resuming follow', async () => {
    const { model } = mount()
    await paint(20)
    const reserve = pixels(model.status.style.marginTop) - pixels(ORIGINAL.margin)
    expect(reserve).toBeGreaterThan(0)
    await lifecycle(true)
    expectNativeSpacing(model)
    expect(shift(model.transcript)).toBe(0)
    expect(model.transcript.style.minHeight).toBe(ORIGINAL.minHeight)
    // A hidden WebView can temporarily lose its measured size. No glyph/resize
    // commit may recreate a stale runway before its foreground layout is ready.
    model.measurable = false
    model.base = 440
    model.viewport = 320
    await act(async () => notifyFollowCommit(model.row))
    expectNativeSpacing(model)
    time += 60000
    await lifecycle(false)
    await paint()
    expectNativeSpacing(model)
    model.measurable = true
    await paint(100)
    expect(model.spacer.style.height).toBe(ORIGINAL.spacer)
    expect(Number.isFinite(shift(model.transcript))).toBe(true)
    expect(model.port.scrollHeight - model.port.clientHeight - model.port.scrollTop).toBeLessThanOrEqual(1)
    // At steady state the normal native gap must not grow into blank viewport
    // space merely because the hidden document had a different viewport size.
    const normalGap = pixels(ORIGINAL.padding) + pixels(ORIGINAL.margin) + pixels(ORIGINAL.spacer)
    expect(model.viewport - model.row.getBoundingClientRect().bottom).toBeLessThanOrEqual(normalGap + 73)
  })

  it('rebases the first measured frame after a long WebView stall without replaying hidden height growth', async () => {
    const { model } = mount()
    await paint(30)
    // No lifecycle signal is guaranteed on all WebView carriers. Real layout
    // grew while RAF was suspended; the first fresh frame must use that layout.
    model.base += 600
    model.viewport = 280
    time += 60000
    await paint()
    const normalGap = pixels(ORIGINAL.padding) + pixels(ORIGINAL.margin) + pixels(ORIGINAL.spacer)
    expect(model.port.scrollHeight - model.port.clientHeight - model.port.scrollTop).toBeLessThanOrEqual(1)
    expect(Math.abs(model.viewport - model.row.getBoundingClientRect().bottom - normalGap)).toBeLessThanOrEqual(8)
    expect(model.spacer.style.height).toBe(ORIGINAL.spacer)
    expect(model.status.textContent).toBe('Working')
  })

  it('does not let a detached completion settle reopen spacing while the WebView is hidden', async () => {
    const { model, complete } = mount()
    await paint(20)
    model.base += 300
    await act(async () => notifyFollowCommit(model.row))
    await paint(2)
    complete()
    await lifecycle(true)
    expectNativeSpacing(model)
    expect(shift(model.transcript)).toBe(0)
    const top = model.port.scrollTop
    // A final model result or an already queued settle callback may run while
    // the WebView is hidden. Neither may resurrect the canceled visual state.
    model.base += 100
    await act(async () => notifyFollowCommit(model.row))
    await paint(100)
    expectNativeSpacing(model)
    expect(shift(model.transcript)).toBe(0)
    expect(model.port.scrollTop).toBe(top)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
  })

  it('does not accumulate runway across repeated rapid hide/show transitions', async () => {
    const { model } = mount()
    await paint(20)
    for (let index = 0; index < 5; index++) {
      await lifecycle(true)
      expectNativeSpacing(model)
      model.viewport += 10
      model.base += 20
      await lifecycle(false)
      await paint(2)
    }
    await paint(100)
    const owned = pixels(model.status.style.marginTop) - pixels(ORIGINAL.margin)
      + pixels(model.transcript.style.paddingBottom) - pixels(ORIGINAL.padding)
    expect(owned).toBeGreaterThanOrEqual(0)
    expect(owned).toBeLessThanOrEqual(72)
    expect(Number.isFinite(shift(model.transcript))).toBe(true)
    expect(model.spacer.style.height).toBe(ORIGINAL.spacer)
    expect(model.status.textContent).toBe('Working')
  })

  it('yields to a native input fold without pinning or changing its spacer and stays passive after remount', async () => {
    const { model, remount } = mount()
    await paint(20)
    expect(pixels(model.status.style.marginTop)).toBeGreaterThan(pixels(ORIGINAL.margin))
    await act(async () => {
      model.spacer.style.height = '240px'
      model.transcript.setAttribute('data-input-fold', '')
      // The native fold owns an intermediate scroll position while its rows
      // and spacer animate together. It must not be pulled to the new floor.
      model.port.scrollTop = 420
    })
    expect(model.status.style.marginTop).toBe(ORIGINAL.margin)
    expect(model.transcript.style.paddingBottom).toBe(ORIGINAL.padding)
    expect(shift(model.transcript)).toBe(0)
    expect(model.spacer.style.height).toBe('240px')
    expect(model.port.scrollTop).toBe(420)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
    await paint(3)
    expect(model.port.scrollTop).toBe(420)
    await act(async () => model.transcript.removeAttribute('data-input-fold'))
    remount()
    await paint(3)
    expect(model.status.style.marginTop).toBe(ORIGINAL.margin)
    expect(model.transcript.style.paddingBottom).toBe(ORIGINAL.padding)
    expect(shift(model.transcript)).toBe(0)
    expect(model.spacer.style.height).toBe('240px')
    expect(model.port.scrollTop).toBe(420)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
  })

  it('does not claim the first frame when the native input fold is already active', async () => {
    const { model } = mount()
    await act(async () => {
      model.spacer.style.height = '240px'
      model.transcript.setAttribute('data-input-fold', '')
      model.port.scrollTop = 420
    })
    await paint()
    expect(model.status.style.marginTop).toBe(ORIGINAL.margin)
    expect(model.transcript.style.paddingBottom).toBe(ORIGINAL.padding)
    expect(model.transcript.style.minHeight).toBe(ORIGINAL.minHeight)
    expect(shift(model.transcript)).toBe(0)
    expect(model.spacer.style.height).toBe('240px')
    expect(model.port.scrollTop).toBe(420)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
  })

  it.each(['lifecycle', 'long-frame'] as const)('keeps a reader who scrolled up released after %s geometry recovery', async mode => {
    const { model } = mount()
    await paint(20)
    fireEvent.wheel(model.port, { deltaY: -80 })
    model.port.scrollTop = 300
    fireEvent.scroll(model.port)
    await paint(3)
    if (mode === 'lifecycle') await lifecycle(true)
    const held = model.port.scrollTop
    model.base += 500
    time += 60000
    if (mode === 'lifecycle') await lifecycle(false)
    await paint(100)
    expect(model.port.scrollTop).toBe(held)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
    expectNativeSpacing(model)
  })
})
