import { act, cleanup, render } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debugRuntime } from '../src/client/debugRuntime.ts'
import { useConversationFollow } from '../src/client/teleprompterGlide.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'

const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] as const
const ORIGINAL = { padding: '13px', margin: '7px', minHeight: '29px', spacer: '48px' }

// jsdom does not lay out calc() or clamp scrollTop after scrollHeight shrinks.
// Model only those browser geometry rules, keeping the production follower real.
function pixels(value: string): number {
  return [...value.matchAll(/(-?[\d.]+)px/g)].reduce((sum, match) => sum + Number(match[1]), 0)
}
function translate(element: HTMLElement): number {
  return Number(/translate3d\(0(?:px)?,\s*(-?[\d.]+)px,\s*0(?:px)?\)/.exec(element.style.transform)?.[1] ?? 0)
}
interface Layout {
  port: HTMLElement
  flow: HTMLElement
  row: HTMLElement
  status: HTMLElement
  spacer: HTMLElement
  base: number
}
function Probe({ active = true, controlScroll = true, layout }: {
  active?: boolean
  controlScroll?: boolean
  layout: { current: Layout | null }
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const speed = useRef(600)
  useLayoutEffect(() => {
    const flow = rootRef.current!
    const port = flow.parentElement!
    const row = flow.querySelector<HTMLElement>('[data-chat-anchor-key]')!
    const status = flow.querySelector<HTMLElement>('[data-chat-turn-status]')!
    const spacer = port.querySelector<HTMLElement>('[data-chat-turn-spacer]')!
    const model: Layout = { port, flow, row, status, spacer, base: 800 }
    layout.current = model
    const height = () => model.base + pixels(flow.style.paddingBottom)
      + pixels(status.style.marginTop) + pixels(spacer.style.height)
    let top = height() - 200
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 200 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: height })
    Object.defineProperty(port, 'scrollTop', {
      configurable: true,
      get: () => Math.max(0, Math.min(top, height() - 200)),
      set: value => { top = Math.max(0, Math.min(Number(value), height() - 200)) },
    })
    vi.spyOn(port, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, bottom: 200, height: 200 }) as DOMRect)
    // This is a reading anchor near the end of the natural transcript. Its
    // screen position includes actual scroll clamping and the rendered shift.
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
      const bottom = model.base - port.scrollTop + translate(flow) + translate(row)
      return { top: bottom - 40, bottom, height: 40 } as DOMRect
    })
    vi.spyOn(flow, 'getBoundingClientRect').mockImplementation(() => {
      const bottom = model.base + pixels(flow.style.paddingBottom) - port.scrollTop + translate(flow)
      return { top: -port.scrollTop + translate(flow), bottom, height: model.base + pixels(flow.style.paddingBottom) } as DOMRect
    })
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const top = model.base + pixels(status.style.marginTop) - port.scrollTop + translate(flow)
      return { top, bottom: top + 20, height: 20 } as DOMRect
    })
  }, [layout])
  useConversationFollow(rootRef, active, speed, undefined, true, false, undefined, undefined, undefined, undefined, controlScroll)
  return <div data-conversation-scroll>
    <div ref={rootRef} data-chat-transcript style={{ paddingBottom: ORIGINAL.padding, minHeight: ORIGINAL.minHeight }}>
      <div data-chat-anchor-key="answer">A visible answer near the bottom</div>
      <div data-chat-turn-status role="status" style={{ marginTop: ORIGINAL.margin }}>Working</div>
    </div>
    <div data-chat-turn-spacer style={{ height: ORIGINAL.spacer }} />
  </div>
}
function tune(runwayPx: number): void {
  debugRuntime.syncSettings({
    enabled: false,
    tuningEnabled: true,
    writable: true,
    dirty: false,
    status: 'ready',
    tuning: { ...DEFAULT_STREAM_DEBUG_TUNING, runwayPx, reserveResponseMs: 350 },
  })
}
function owned(model: Layout): number {
  return Math.max(0, pixels(model.status.style.marginTop) - pixels(ORIGINAL.margin))
    + Math.max(0, pixels(model.flow.style.paddingBottom) - pixels(ORIGINAL.padding))
}
function assertOriginal(model: Layout): void {
  expect(model.status.style.marginTop).toBe(ORIGINAL.margin)
  expect(model.flow.style.paddingBottom).toBe(ORIGINAL.padding)
  expect(model.flow.style.minHeight).toBe(ORIGINAL.minHeight)
  expect(model.flow.style.transform).toBe('')
  expect(model.row.style.transform).toBe('')
  expect(model.spacer.style.height).toBe(ORIGINAL.spacer)
}
async function frames(count: number, observe?: () => void): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(() => vi.advanceTimersByTimeAsync(16))
    observe?.()
  }
}
function mount(active = true, controlScroll = true) {
  const layout = { current: null as Layout | null }
  const view = render(<Probe layout={layout} active={active} controlScroll={controlScroll} />)
  return { view, model: layout.current!, update: (nextActive: boolean, nextControl: boolean) => view.rerender(<Probe layout={layout} active={nextActive} controlScroll={nextControl} />) }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE] })
  debugRuntime.resetRuntime()
})
afterEach(() => {
  cleanup()
  debugRuntime.resetRuntime()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('predictive runway physical budget', () => {
  it('starts with no extra runway at zero and preserves native spacing', async () => {
    tune(0)
    const { model } = mount()
    await frames(30)
    expect(owned(model)).toBe(0)
    expect(model.spacer.style.height).toBe(ORIGINAL.spacer)
    expect(model.status.style.marginTop).toBe(ORIGINAL.margin)
    expect(model.flow.style.paddingBottom).toBe(ORIGINAL.padding)
  })

  it('caps 72 -> 40 -> 0 immediately and releases the reading anchor without a large frame jump', async () => {
    tune(72)
    const { model } = mount()
    await frames(30)
    expect(owned(model)).toBeGreaterThan(60)
    for (const cap of [40, 0]) {
      let previous = model.row.getBoundingClientRect().bottom
      const anchorAtChange = previous
      tune(cap)
      await frames(100, () => {
        expect(owned(model)).toBeLessThanOrEqual(cap + 0.1)
        const next = model.row.getBoundingClientRect().bottom
        expect(Number.isFinite(next)).toBe(true)
        // A 40/72px layout clamp must not paint as one large reader jump.
        expect(Math.abs(next - previous)).toBeLessThanOrEqual(12)
        previous = next
      })
      expect(Math.abs(previous - anchorAtChange)).toBeLessThanOrEqual(73)
      if (cap === 0) expect(Math.abs(translate(model.flow))).toBeLessThan(1)
    }
    expect(model.spacer.style.height).toBe(ORIGINAL.spacer)
  })

  it('respects the lowered budget during completion handoff and never reopens zero runway', async () => {
    tune(72)
    const { model, update } = mount()
    await frames(30)
    tune(0)
    update(false, true)
    await frames(180, () => expect(owned(model)).toBe(0))
    expect(model.port.hasAttribute('data-follow-owned')).toBe(false)
    expect(model.port.style.overflowAnchor).toBe('')
    expect(model.port.style.scrollBehavior).toBe('')
    expect(model.flow.style.transform).toBe('')
    expect(model.spacer.style.height).toBe(ORIGINAL.spacer)
  })

  it.each(['settling', 'settled'] as const)('reclaims existing completion space when the budget is lowered while %s', async phase => {
    tune(72)
    const { model, update } = mount()
    await frames(30)
    update(false, true)
    await frames(phase === 'settling' ? 5 : 220)
    if (phase === 'settled') expect(pixels(model.flow.style.paddingBottom)).toBeGreaterThan(pixels(ORIGINAL.padding))
    tune(0)
    // Settings subscriptions must enforce the cap even without an active arm.
    expect(owned(model)).toBe(0)
    let previous = model.row.getBoundingClientRect().bottom
    await frames(100, () => {
      expect(owned(model)).toBe(0)
      const next = model.row.getBoundingClientRect().bottom
      expect(Math.abs(next - previous)).toBeLessThanOrEqual(12)
      previous = next
    })
    expect(model.spacer.style.height).toBe(ORIGINAL.spacer)
  })

  it.each(['active', 'settling', 'settled'] as const)('restores only owned styles when scroll control is disabled while %s', async phase => {
    tune(72)
    const { model, update } = mount()
    await frames(30)
    expect(owned(model)).toBeGreaterThan(60)
    if (phase !== 'active') {
      update(false, true)
      await frames(phase === 'settling' ? 5 : 220)
      if (phase === 'settled') expect(pixels(model.flow.style.paddingBottom)).toBeGreaterThan(pixels(ORIGINAL.padding))
    }
    update(phase === 'active', false)
    await frames(3)
    assertOriginal(model)
    // Old completion callbacks/observers must not recreate plugin spacing.
    model.base += 24
    await frames(30)
    assertOriginal(model)
  })

  it('preserves pre-existing transform and scroll styles across ownership and completion', async () => {
    tune(72)
    const { model, update } = mount(false, false)
    model.flow.style.transform = 'scale(0.99)'
    model.flow.style.willChange = 'opacity'
    model.flow.style.clipPath = 'inset(1px)'
    model.port.style.scrollBehavior = 'smooth'
    model.port.style.overflowAnchor = 'auto'
    update(true, true)
    await frames(30)
    expect(model.flow.style.transform).toContain('scale(0.99)')
    update(false, true)
    await frames(220)
    update(false, false)
    await frames(3)
    expect(model.flow.style.transform).toBe('scale(0.99)')
    expect(model.flow.style.willChange).toBe('opacity')
    expect(model.flow.style.clipPath).toBe('inset(1px)')
    expect(model.port.style.scrollBehavior).toBe('smooth')
    expect(model.port.style.overflowAnchor).toBe('auto')
    expect(model.spacer.style.height).toBe(ORIGINAL.spacer)
  })

  it('can enable scroll control again after complete cleanup using the current budget', async () => {
    tune(72)
    const { model, update } = mount()
    await frames(30)
    update(true, false)
    await frames(3)
    assertOriginal(model)
    tune(40)
    update(true, true)
    await frames(30)
    expect(owned(model)).toBeGreaterThan(0)
    expect(owned(model)).toBeLessThanOrEqual(40.1)
    update(true, false)
    await frames(3)
    assertOriginal(model)
  })
})
