import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debugRuntime } from '../src/client/debugRuntime.ts'
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

function Arm({ active = true }: { active?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const speed = useRef(600)
  useConversationFollow(root, active, speed)
  return <div ref={root}>A live answer</div>
}
function Conversation({ layout, generation = 0, active = true }: {
  layout: { current: Layout | null }
  generation?: number
  active?: boolean
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
      <div data-chat-anchor-key="answer"><Arm key={generation} active={active} /></div>
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
  }
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
  debugRuntime.resetRuntime()
  debugRuntime.syncSettings({
    enabled: false, tuningEnabled: true, writable: true, dirty: false, status: 'ready',
    tuning: { ...DEFAULT_STREAM_DEBUG_TUNING, runwayPx: 72, reserveResponseMs: 350 },
  })
})
afterEach(() => {
  cleanup()
  debugRuntime.resetRuntime()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('conversation follow across WebView recovery', () => {
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
