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
    unmount: () => view.unmount(),
    remount: () => view.rerender(<Conversation layout={layout} generation={1} />),
    complete: () => view.rerender(<Conversation layout={layout} active={false} />),
  }
}
async function paint(count = 1, delta = 16) {
  for (let index = 0; index < count; index++) await act(async () => {
    time += delta
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

describe('conversation follow with ordinary frame timing', () => {
  it.each([false, true])('keeps host handoff across arm mounts and lifecycle events (background=%s)', async background => {
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

  it('leaves owned geometry and scheduled motion intact across lifecycle events', async () => {
    const { model } = mount()
    await paint(20)
    const before = {
      margin: model.status.style.marginTop,
      padding: model.transcript.style.paddingBottom,
      minHeight: model.transcript.style.minHeight,
      shift: shift(model.transcript),
      scrollTop: model.port.scrollTop,
      owned: model.port.hasAttribute('data-follow-owned'),
      frames: frames.size,
    }
    expect(pixels(before.margin)).toBeGreaterThan(pixels(ORIGINAL.margin))
    await lifecycle(true)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('pagehide'))
      window.dispatchEvent(new Event('freeze'))
    })
    expect({
      margin: model.status.style.marginTop,
      padding: model.transcript.style.paddingBottom,
      minHeight: model.transcript.style.minHeight,
      shift: shift(model.transcript),
      scrollTop: model.port.scrollTop,
      owned: model.port.hasAttribute('data-follow-owned'),
      frames: frames.size,
    }).toEqual(before)
    model.base += 26
    await act(async () => notifyFollowCommit(model.row))
    await paint()
    expect(model.port.scrollTop).toBe(model.port.scrollHeight - model.port.clientHeight)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(true)
    await lifecycle(false)
    expect(model.spacer.style.height).toBe(ORIGINAL.spacer)
  })

  it('treats a long frame exactly like the normal 32ms motion cap without rebasing', async () => {
    const run = async (delta: number) => {
      const { model, unmount } = mount()
      await paint(20)
      model.base += 26
      await paint(1, delta)
      const result = {
        margin: model.status.style.marginTop,
        padding: model.transcript.style.paddingBottom,
        shift: shift(model.transcript),
        scrollTop: model.port.scrollTop,
        owned: model.port.hasAttribute('data-follow-owned'),
      }
      unmount()
      await paint(120)
      return result
    }
    expect(await run(60000)).toEqual(await run(32))
  })

  it('continues an ordinary completion settle across lifecycle events', async () => {
    const { model, complete } = mount()
    await paint(20)
    model.base += 26
    await act(async () => notifyFollowCommit(model.row))
    await paint(2)
    complete()
    const margin = pixels(model.status.style.marginTop)
    await lifecycle(true)
    expect(pixels(model.status.style.marginTop)).toBe(margin)
    await paint(20)
    expect(pixels(model.status.style.marginTop)).toBeLessThan(margin)
    expect(model.spacer.style.height).toBe(ORIGINAL.spacer)
    expect(Number.isFinite(shift(model.transcript))).toBe(true)
  })

  it('keeps the ordinary runway budget across repeated lifecycle events', async () => {
    const { model } = mount()
    await paint(20)
    for (let index = 0; index < 5; index++) {
      await lifecycle(true)
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

  it.each(['lifecycle', 'long-frame'] as const)('keeps a reader who scrolled up released across a %s interval', async mode => {
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
