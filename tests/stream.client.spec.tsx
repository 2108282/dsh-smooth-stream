import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createElement,
  memo,
  useRef,
  type FunctionComponent,
} from 'react'
import { MarkdownText, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import {
  computeFollowRevealScale,
  computeFollowReserve,
  computeFollowStep,
  computeFollowTrajectoryStep,
  FOLLOW_SPEED_REF_CPS,
  FOLLOW_STATUS_RUNWAY_PX,
  FOLLOW_RESERVE_MIN_PX,
  FollowRevealPhaseTracker,
  useConversationFollow,
} from '../src/client/teleprompterGlide.ts'
import {
  BACKLOG_CHAR_CEILING,
  BACKLOG_SECOND_CEILING,
  PRESET_CONFIG,
  computeAdaptiveQueueStep,
  computeCompletionDrain,
  computeQueueReveal,
  computeSettleDrain,
  useSmoothStreamContent,
} from '../src/client/useSmoothStreamContent.ts'
import { apply, inject } from '../src/client/index.ts'
import { DEFAULT_STREAM_CONFIG, STREAM_BOOT_GLOBAL } from '../src/config.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'
import { debugRuntime } from '../src/client/debugRuntime.ts'
import { Config } from '../src/plugin.ts'

const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] as const

afterEach(() => {
  cleanup()
  debugRuntime.resetRuntime()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/**
 * Stand-in for the layered `t` the seat injects.
 *
 * It reads the plugin's REAL `message.think` dictionary rather than returning a
 * literal, so a missing or renamed key surfaces here as the raw key instead of
 * passing silently. What it deliberately does NOT model is the namespace
 * layering itself (`conversation` -> `chat` -> plugin fallback); that contract
 * has its own suite in `locale-routing.client.spec.tsx`, which runs against
 * real `LocaleRuntime` instances and the real Harness dictionaries.
 */
type AssistantOwner = ChatNodeViewProps<'assistant-step'>

/** Minimal official owner fixture; lifecycle tests exercise the shipped renderer contract. */
function assistantProps(status: 'running' | 'settled', blocks: unknown[]): AssistantOwner {
  return {
    node: {
      kind: 'assistant-step',
      location: { kind: 'unresolved' },
      data: { status, blocks, turn: 1, step: 1, time: 0 },
    },
    useTurnData: () => undefined,
    openFile: () => {},
    fileMentions: () => undefined,
    t: (key: string) => key,
  } as unknown as AssistantOwner
}

function currentTranslate(element: HTMLElement): number {
  return Number(
    /translate3d\(0(?:px)?,\s*(-?[\d.]+)px,\s*0(?:px)?\)/.exec(element.style.transform)?.[1] ?? 0,
  )
}

function SmoothProbe({
  text,
  inputComplete,
  shouldHoldBack,
  steadyCps,
  revealScaleRef,
  speedCpsRef,
  revealedCharsRef,
  onRevealCommit,
}: {
  text: string
  inputComplete?: boolean
  shouldHoldBack?: () => boolean
  steadyCps?: number
  revealScaleRef?: { current: number }
  speedCpsRef?: { current: number }
  revealedCharsRef?: { current: number }
  onRevealCommit?: () => void
}) {
  const displayed = useSmoothStreamContent(text, {
    inputComplete: inputComplete ?? false,
    shouldHoldBack,
    steadyCps,
    revealScaleRef,
    speedCpsRef,
    revealedCharsRef,
    onRevealCommit,
  })
  return <span>{displayed}</span>
}

function FollowProbe({
  active = true,
  controlScroll = true,
  speedCps = FOLLOW_SPEED_REF_CPS,
  revealScaleRef,
}: {
  active?: boolean
  controlScroll?: boolean
  speedCps?: number
  revealScaleRef?: { current: number }
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const speedCpsRef = useRef(speedCps)
  speedCpsRef.current = speedCps
  useConversationFollow(rootRef, active, speedCpsRef, revealScaleRef, true, false, undefined, undefined, undefined, undefined, controlScroll)
  return <div ref={rootRef} data-chat-transcript>Streaming response</div>
}

function FollowTooltipProbe({ portal = false }: { portal?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const speedCpsRef = useRef(600)
  useConversationFollow(rootRef, true, speedCpsRef)
  return (
    <div ref={rootRef} data-tooltip-probe>
      <span>user message</span>
      <span>
        <Tooltip label="Copy" side="bottom" portal={portal}>
          <button type="button">copy</button>
        </Tooltip>
      </span>
    </div>
  )
}

describe('useSmoothStreamContent', () => {
  it('publishes only the character count that has committed to the display', async () => {
    const revealedCharsRef = { current: -1 }
    const commitCounts: number[] = []
    const content = 'x'.repeat(100)
    const view = render(
      <SmoothProbe
        text={content}
        steadyCps={25}
        revealedCharsRef={revealedCharsRef}
        onRevealCommit={() => { commitCounts.push(revealedCharsRef.current) }}
      />,
    )
    expect(revealedCharsRef.current).toBe(0)

    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(revealedCharsRef.current).toBe(view.container.textContent?.length)
    expect(revealedCharsRef.current).toBeGreaterThan(0)
    expect(revealedCharsRef.current).toBeLessThan(content.length)
    expect(commitCounts.every(count => count === view.container.textContent?.length)).toBe(true)
  })

  beforeEach(() => vi.useFakeTimers({ toFake: [...FAKE] }))

  it('queues content already present on the first streaming render', async () => {
    const content = 'fast provider batch '.repeat(20)
    const view = render(<SmoothProbe text={content} />)

    expect(view.container.textContent).toBe('')
    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(view.container.textContent?.length).toBeGreaterThan(0)
    expect(view.container.textContent?.length).toBeLessThan(content.length)
    await act(() => vi.advanceTimersByTimeAsync(8000))
    expect(view.container.textContent).toBe(content)
  })

  it('reveals an appended stream progressively instead of dumping it', async () => {
    const view = render(<SmoothProbe text="" />)
    view.rerender(<SmoothProbe text={'x'.repeat(40)} />)

    expect(view.container.textContent).toBe('')
    await act(() => vi.advanceTimersByTimeAsync(120))
    const partial = view.container.textContent?.length ?? 0
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(40)

    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(view.container.textContent).toBe('x'.repeat(40))
  })

  it('integrates the pressure queue on each 120Hz frame', () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const view = render(<SmoothProbe text="" />)

    try {
      view.rerender(<SmoothProbe text="xxx" />)
      act(() => frames.shift()?.(0))
      act(() => frames.shift()?.(1000 / 120))
      expect(view.container.textContent).toBe('')
      act(() => frames.shift()?.(2000 / 120))
      expect(view.container.textContent).toHaveLength(1)
      act(() => frames.shift()?.(3000 / 120))
      expect(view.container.textContent).toHaveLength(2)
    } finally {
      view.unmount()
      requestFrame.mockRestore()
    }
  })

  it('slows the pressure queue while the follow spring needs paint headroom', async () => {
    const revealScaleRef = { current: 0.55 }
    const throttled = render(<SmoothProbe text={'x'.repeat(600)} revealScaleRef={revealScaleRef} />)
    await act(() => vi.advanceTimersByTimeAsync(1000))
    const throttledCount = throttled.container.textContent?.length ?? 0
    throttled.unmount()

    const unrestricted = render(<SmoothProbe text={'x'.repeat(600)} />)
    await act(() => vi.advanceTimersByTimeAsync(1000))
    const unrestrictedCount = unrestricted.container.textContent?.length ?? 0

    expect(throttledCount).toBeGreaterThan(100)
    expect(throttledCount).toBeLessThan(unrestrictedCount * 0.7)
  })

  it('drains a producer-complete tail at bounded speed without live backpressure', async () => {
    // The old contract published the whole accumulated source in one commit:
    // a fast stream ending with standing backlog teleported hundreds of px
    // in a single frame. The tail now closes at a bounded, ramped constant
    // velocity — never teleporting, never dragging an exponential tail.
    const revealScaleRef = { current: 0.55 }
    const content = 'x'.repeat(300)
    const view = render(
      <SmoothProbe text={content} revealScaleRef={revealScaleRef} />,
    )
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(view.container.textContent?.length).toBeLessThan(content.length)

    view.rerender(
      <SmoothProbe text={content} inputComplete revealScaleRef={revealScaleRef} />,
    )
    // No single-commit teleport: the drain needs at least one frame.
    expect(view.container.textContent?.length).toBeLessThan(content.length)
    await act(() => vi.advanceTimersByTimeAsync(800))
    expect(view.container.textContent).toBe(content)
  })

  it('drains a large producer-complete tail near its configured deadline', async () => {
    const content = 'x'.repeat(2000)
    const view = render(<SmoothProbe text={content} />)
    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(view.container.textContent?.length).toBeLessThan(content.length / 4)

    view.rerender(<SmoothProbe text={content} inputComplete />)
    expect(view.container.textContent?.length).toBeLessThan(content.length)
    // Completion has its own deadline budget and may exceed the live-stream
    // speed ceiling, while the ramp still prevents a single-commit teleport.
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(view.container.textContent).toBe(content)
  })

  it('reveals at the steady rate while input streams and drains at 1.8x after', async () => {
    const view = render(<SmoothProbe text="" steadyCps={25} />)
    view.rerender(<SmoothProbe text={'x'.repeat(100)} steadyCps={25} />)
    // One commit per available frame: several glyphs land, far below the input.
    await act(() => vi.advanceTimersByTimeAsync(200))
    const partial = view.container.textContent?.length ?? 0
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(40)
    // After the (fake) stream goes idle and settling kicks in, the 1.8x
    // drain clears the remaining backlog quickly but not instantly.
    await act(() => vi.advanceTimersByTimeAsync(2500))
    expect(view.container.textContent).toBe('x'.repeat(100))
  })

  it('keeps up with a fast chunked arrival instead of trailing at the old 72cps cap', async () => {
    const view = render(<SmoothProbe text="" />)
    view.rerender(<SmoothProbe text={'x'.repeat(20)} />)
    await act(() => vi.advanceTimersByTimeAsync(40))
    view.rerender(<SmoothProbe text={'x'.repeat(40)} />)
    await act(() => vi.advanceTimersByTimeAsync(40))
    view.rerender(<SmoothProbe text={'x'.repeat(60)} />)
    await act(() => vi.advanceTimersByTimeAsync(40))
    view.rerender(<SmoothProbe text={'x'.repeat(80)} />)
    await act(() => vi.advanceTimersByTimeAsync(80))
    const partial = view.container.textContent?.length ?? 0
    // 80 chars over ~200ms is 400 cps arrival. The old maxCps=72 cap would
    // have revealed ~15 chars; keep-up must be well past that.
    expect(partial).toBeGreaterThan(25)
    expect(partial).toBeLessThanOrEqual(80)
  })

  it('queues a large append instead of dumping it', async () => {
    const view = render(<SmoothProbe text="" />)
    view.rerender(<SmoothProbe text={'x'.repeat(240)} />)
    await act(() => vi.advanceTimersByTimeAsync(120))
    const partial = view.container.textContent?.length ?? 0
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(240)
    await act(() => vi.advanceTimersByTimeAsync(8000))
    expect(view.container.textContent).toBe('x'.repeat(240))
  })

  it('holds back the DOM commit while the guard vetoes and flushes after', async () => {
    let hold = true
    const view = render(<SmoothProbe text="" shouldHoldBack={() => hold} />)
    view.rerender(<SmoothProbe text="hello world" shouldHoldBack={() => hold} />)

    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(view.container.textContent).toBe('')

    hold = false
    view.rerender(<SmoothProbe text="hello world" shouldHoldBack={() => hold} />)
    await act(() => vi.advanceTimersByTimeAsync(1200))
    expect(view.container.textContent).toBe('hello world')
  })

  it('returns the shared reveal speed to idle when its queue drains', async () => {
    const speedCpsRef = { current: 35 }
    const view = render(<SmoothProbe text={'x'.repeat(300)} speedCpsRef={speedCpsRef} />)
    await act(() => vi.advanceTimersByTimeAsync(160))
    expect(speedCpsRef.current).toBeGreaterThan(PRESET_CONFIG.balanced.defaultCps)

    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(view.container.textContent).toBe('x'.repeat(300))
    expect(speedCpsRef.current).toBe(PRESET_CONFIG.balanced.defaultCps)
  })
})

describe('conversation follow', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: [...FAKE] }))

  it('does not jump the visible transcript when one new line lands', async () => {
    let baseHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe speedCps={100} />
        <div data-chat-turn-status role="status">Deep diving...</div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(status.style.marginTop) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 - (Number.parseFloat(status.style.marginTop) || 0) + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 122 } as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 176 } as DOMRect)

    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(600))
    const before = -port.scrollTop + currentTranslate(transcript)

    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    const after = -port.scrollTop + currentTranslate(transcript)

    expect(Math.abs(after - before)).toBeLessThanOrEqual(4)
  })

  it('holds a surface untransformed while a fixed tooltip is open, then resumes shifting', async () => {
    let baseHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe speedCps={600} />
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight,
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 176 } as DOMRect)

    // Without a tooltip the follow shift applies to the surface directly.
    const bubble = document.createElement('span')
    bubble.textContent = 'user message'
    transcript.replaceChildren(bubble)
    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(240))
    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    const shiftedWithoutTooltip = currentTranslate(transcript)
    expect(shiftedWithoutTooltip).toBeGreaterThan(0)

    // While an open fixed tooltip lives on the surface the guard holds it
    // untransformed: no transform becomes the tooltip's fixed containing
    // block, so the bubble keeps viewport coordinates and the tooltip stays
    // glued to its anchor.
    const actions = document.createElement('span')
    const copy = document.createElement('button')
    copy.textContent = 'copy'
    const tooltip = document.createElement('span')
    tooltip.setAttribute('role', 'tooltip')
    tooltip.textContent = 'Copy'
    actions.append(copy, tooltip)
    transcript.append(actions)
    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(transcript.style.transform).toBe('')
    expect(currentTranslate(transcript)).toBe(0)
    expect(currentTranslate(bubble)).toBe(0)
    expect(tooltip.style.transform).toBe('')

    // Once the tooltip closes, the next follow frame resumes the shift.
    tooltip.remove()
    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(currentTranslate(transcript)).toBeGreaterThan(0)
  })

  it('does not reset the conversation when the real Tooltip mounts on hover', async () => {
    let baseHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <div data-chat-flow>
          <div data-chat-anchor-key="user">
            <FollowTooltipProbe />
          </div>
        </div>
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const surface = view.container.querySelector('[data-chat-anchor-key="user"]') as HTMLElement
    const transcript = view.container.querySelector('[data-tooltip-probe]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight,
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 176 } as DOMRect)

    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(240))
    const beforeTop = port.scrollTop
    const message = view.getByText('user message')
    const visualPosition = (): number => (
      -port.scrollTop
        + currentTranslate(surface)
        + currentTranslate(transcript)
        + currentTranslate(message)
    )
    const beforeHover = visualPosition()
    const button = view.getByRole('button', { name: 'copy' })
    // The current primitive listens to pointer entry rather than mouse entry.
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target, borderBoxSize: [{ inlineSize: 48, blockSize: 24 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      disconnect() {}
    })
    fireEvent.pointerEnter(button)
    expect(view.getByRole('tooltip').textContent).toBe('Copy')
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(visualPosition()).toBeCloseTo(beforeHover, 5)
    expect(surface.style.transform).toBe('')
    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))

    expect(port.scrollTop).toBeGreaterThanOrEqual(beforeTop)
    expect(port.scrollTop).toBeLessThanOrEqual(baseHeight - port.clientHeight)
    expect(transcript.style.transform).toBe('')
    expect(view.container.querySelector('[role="tooltip"]')?.getAttribute('role')).toBe('tooltip')
    expect((view.container.querySelector('[role="tooltip"]') as HTMLElement).style.transform).toBe('')
  })

  it('preserves the follow surface when a real portaled Tooltip opens on keyboard focus', async () => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        // Tooltip stays hidden until its real primitive receives a laid-out
        // border box; supply that browser measurement instead of querying hidden UI.
        this.callback([{ target, borderBoxSize: [{ inlineSize: 48, blockSize: 24 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      disconnect() {}
    })
    const view = render(
      <div data-conversation-scroll>
        <FollowTooltipProbe portal />
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-tooltip-probe]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, value: 500 })
    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(80))
    const before = -port.scrollTop + currentTranslate(transcript)
    const button = view.getByRole('button', { name: 'copy' })
    // Tooltip's modality gate accepts keyboard focus after a key event.
    fireEvent.keyDown(document, { key: 'Tab' })
    fireEvent.focus(button)
    const tooltip = view.getByRole('tooltip')
    expect(tooltip.closest('[data-conversation-scroll]')).toBeNull()
    expect(tooltip.parentElement).toBe(document.body)
    expect(tooltip.getAttribute('data-portal')).toBe('true')
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(-port.scrollTop + currentTranslate(transcript)).toBeCloseTo(before, 5)
    fireEvent.blur(button)
    expect(view.queryByRole('tooltip')).toBeNull()
  })

  for (const scenario of [
    { speedCps: 300, wrapIntervalMs: 192, maxDisplacementPx: 4 },
    { speedCps: 600, wrapIntervalMs: 96, maxDisplacementPx: 8 },
  ]) {
    it(`keeps ${scenario.speedCps}cps wrap frames within the continuous-motion limit`, async () => {
      let baseHeight = 500
      const view = render(
        <div data-conversation-scroll>
          <FollowProbe speedCps={scenario.speedCps} />
          <div data-composer-seat>Composer</div>
        </div>,
      )
      const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
      const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
      const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
      Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
      Object.defineProperty(port, 'scrollHeight', {
        configurable: true,
        get: () => baseHeight + (Number.parseFloat(transcript.style.marginBottom) || 0),
      })
      vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
        top: 0,
        bottom: 80 - (Number.parseFloat(transcript.style.marginBottom) || 0) + currentTranslate(transcript),
      }) as DOMRect)
      vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 96, bottom: 176 } as DOMRect)

      port.scrollTop = 400
      await act(() => vi.advanceTimersByTimeAsync(240))

      for (let index = 0; index < 20; index += 1) {
        const before = -port.scrollTop + currentTranslate(transcript)
        baseHeight += 28
        await act(() => vi.advanceTimersByTimeAsync(16))
        const floor = port.scrollHeight - port.clientHeight
        const after = -port.scrollTop + currentTranslate(transcript)
        expect(port.scrollTop).toBeCloseTo(floor, 5)
        expect(Math.abs(after - before)).toBeLessThanOrEqual(scenario.maxDisplacementPx)
        expect(transcript.getBoundingClientRect().bottom).toBeLessThan(96)
        await act(() => vi.advanceTimersByTimeAsync(scenario.wrapIntervalMs - 16))
      }

      view.unmount()
    })
  }

  it('applies live predictive-runway tuning while a reply is streaming', async () => {
    const baseHeight = 500
    debugRuntime.syncSettings({
      enabled: true,
      tuningEnabled: true,
      writable: true,
      dirty: false,
      status: 'ready',
      tuning: DEFAULT_STREAM_DEBUG_TUNING,
    })
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe speedCps={600} />
        <div data-chat-turn-status role="status">Deep diving...</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const status = view.container.querySelector('[data-chat-turn-status]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(status.style.marginTop) || 0) + (Number.parseFloat(transcript.style.paddingBottom) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 - (Number.parseFloat(status.style.marginTop) || 0) + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => {
      const runway = Number.parseFloat(status.style.marginTop) || 0
      return { top: 96 + runway, bottom: 122 + runway } as DOMRect
    })

    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(240))
    expect(Number.parseFloat(status.style.marginTop)).toBeCloseTo(72, 0)

    debugRuntime.syncSettings({
      enabled: true,
      tuningEnabled: true,
      writable: true,
      dirty: true,
      status: 'ready',
      tuning: { ...DEFAULT_STREAM_DEBUG_TUNING, runwayPx: 40 },
    })
    await act(() => vi.advanceTimersByTimeAsync(900))
    const ownedSpace = () => (Number.parseFloat(status.style.marginTop) || 0)
      + (Number.parseFloat(transcript.style.paddingBottom) || 0)
    expect(ownedSpace()).toBeLessThanOrEqual(40)
    debugRuntime.syncSettings({
      enabled: false,
      tuningEnabled: true,
      writable: true,
      dirty: true,
      status: 'ready',
      tuning: { ...DEFAULT_STREAM_DEBUG_TUNING, runwayPx: 0 },
    })
    await act(() => vi.advanceTimersByTimeAsync(32))
    expect(ownedSpace()).toBe(0)
  })

  it('restores the transcript min-height when the follow host unmounts', async () => {
    const renderFollow = (active: boolean) => (
      <div data-conversation-scroll>
        <FollowProbe active={active} />
      </div>
    )
    const view = render(renderFollow(true))
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => Math.max(40, Number.parseFloat(transcript.style.minHeight) || 0),
    })

    await act(() => vi.advanceTimersByTimeAsync(32))
    expect(transcript.style.minHeight).toBe('100px')

    view.unmount()
    await act(() => vi.advanceTimersByTimeAsync(32))
    expect(transcript.style.minHeight).toBe('')
  })

  it('adds reveal backpressure before a narrow safe gap forces a hard catch-up', async () => {
    let baseHeight = 500
    const revealScaleRef = { current: 1 }
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe speedCps={600} revealScaleRef={revealScaleRef} />
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(transcript.style.marginBottom) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 - (Number.parseFloat(transcript.style.marginBottom) || 0) + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 82, bottom: 162 } as DOMRect)

    port.scrollTop = 400
    await act(() => vi.advanceTimersByTimeAsync(240))
    baseHeight += 28
    await act(() => vi.advanceTimersByTimeAsync(16))

    expect(revealScaleRef.current).toBeLessThan(0.75)
    expect(revealScaleRef.current).toBeGreaterThanOrEqual(0.55)
    expect(port.scrollTop).toBeCloseTo(port.scrollHeight - port.clientHeight, 5)
    expect(transcript.getBoundingClientRect().bottom).toBeLessThan(82)
  })

  it('keeps chrome clearance and bottom follow after a long main-thread stall', () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const cancelFrame = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined)
    let clockNow = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => clockNow)
    let baseHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe />
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(transcript.style.marginBottom) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 - (Number.parseFloat(transcript.style.marginBottom) || 0) + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 400, bottom: 480 } as DOMRect)

    const step = (advanceMs: number): void => {
      clockNow += advanceMs
      act(() => frames.shift()?.(clockNow))
    }

    try {
      port.scrollTop = 390
      step(0)
      for (let index = 0; index < 4; index += 1) {
        baseHeight += 28
        step(16)
      }
      // A 250ms stall while the stream kept growing: heavy markdown frames
      // stretch far past the 32ms spring clamp, and the follower must still
      // track growth measured in real time.
      baseHeight += 300
      step(250)
      for (let index = 0; index < 5; index += 1) {
        baseHeight += 5
        step(16)
        const floor = port.scrollHeight - port.clientHeight
        expect(port.scrollTop).toBeCloseTo(floor, 5)
        expect(transcript.getBoundingClientRect().bottom).toBeLessThan(400)
      }
    } finally {
      view.unmount()
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      clock.mockRestore()
    }
  })

  it('caps a dropped RAF interval so the first recovery paint does not teleport', () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const cancelFrame = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    let baseHeight = 500
    const view = render(
      <div data-conversation-scroll>
        <FollowProbe />
        <div data-composer-seat>Composer</div>
      </div>,
    )
    const port = view.container.querySelector('[data-conversation-scroll]') as HTMLElement
    const transcript = view.container.querySelector('[data-chat-transcript]') as HTMLElement
    const composer = view.container.querySelector('[data-composer-seat]') as HTMLElement
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(port, 'scrollHeight', {
      configurable: true,
      get: () => baseHeight + (Number.parseFloat(transcript.style.marginBottom) || 0),
    })
    vi.spyOn(transcript, 'getBoundingClientRect').mockImplementation(() => ({
      top: 0,
      bottom: 80 - (Number.parseFloat(transcript.style.marginBottom) || 0) + currentTranslate(transcript),
    }) as DOMRect)
    vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 400, bottom: 480 } as DOMRect)

    try {
      port.scrollTop = 390
      act(() => frames.shift()?.(0))
      const before = -port.scrollTop + currentTranslate(transcript)
      baseHeight = 700
      act(() => frames.shift()?.(100))

      const after = -port.scrollTop + currentTranslate(transcript)
      const springAdvance = computeFollowStep(32, {
        lag: 200,
        speedEma: FOLLOW_SPEED_REF_CPS,
      }).advancePx
      // Composer-only follow does not pre-open a runway at the 35cps neutral
      // seed; the clamped 32ms spring step is therefore the whole movement.
      expect(before - after).toBeCloseTo(springAdvance, 5)
    } finally {
      view.unmount()
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      clock.mockRestore()
    }
  })

})


describe('client plugin lifecycle', () => {
  const pendingDisposals: Array<() => Promise<unknown>> = []
  afterEach(async () => {
    for (const dispose of pendingDisposals.splice(0)) await dispose()
  })

  function registerOfficialAssistant(ctx: Context): void {
    function OfficialAssistant({ node }: AssistantOwner) {
      return <>{node.data.blocks.map((block, index) => block.kind === 'text'
        ? <MarkdownText key={index} text={block.text} streaming={node.data.status === 'running'} labels={{ code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }} />
        : null)}</>
    }
    ctx.slots.register({ name: 'conversation.chat.node', key: 'assistant-step', priority: 20 } as never, OfficialAssistant as never)
  }

  it('wraps the official assistant entry in place and restores it on disposal', async () => {
    expect(inject).toEqual(['slots'])
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'assistant-step',
      priority: 20,
      children: { 'assistant.child': { kind: 'list', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'tool-call',
    } as never, (() => null) as never)
    const assistant = ctx.slots.entries('conversation.chat.node')
      .find(entry => entry.options.key === 'assistant-step')!
    const original = assistant.component
    const originalOptions = { ...assistant.options }
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(ctx.slots.entries('conversation.chat.node')).toHaveLength(2)
    expect(assistant.component).not.toBe(original)
    expect(assistant.options).toEqual(originalOptions)

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.chat.node')).toHaveLength(2)
    expect(assistant.component).toBe(original)
    expect(assistant.options).toEqual(originalOptions)
  })

  it('leaves a pre-registered tool-call native when the playback flow is absent', async () => {
    function DummyTool({ node }: { node: { data: { root: object } } }) {
      return <div>tool:{'kind' in node.data.root ? 'settled' : 'running'}</div>
    }
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'tool-call',
      children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
    } as never, DummyTool as never)
    registerOfficialAssistant(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = ctx.slots.entries('conversation.chat.node').find(item => item.options.key === 'tool-call')
    expect(entry?.component).not.toBe(DummyTool)
    const view = render(createElement(entry?.component as FunctionComponent<{ node: { data: { root: object } } }>, {
      node: { data: { root: { callId: '1', name: 'bash' } } },
    }))
    expect(view.container.querySelector('[data-entrance]')).toBeNull()
    expect(view.getByText('tool:running')).not.toBeNull()

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.chat.node').find(item => item.options.key === 'tool-call')?.component).toBe(DummyTool)
  })

  it('wraps memoized Agent rows while preserving memoized human rows', async () => {
    const ContextRow = memo(function ContextRow() {
      return <div>context</div>
    })
    const UserRow = memo(function UserRow() {
      return <div>user</div>
    })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'context',
    } as never, ContextRow as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'user',
    } as never, UserRow as never)

    registerOfficialAssistant(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const contextEntry = ctx.slots.entries('conversation.chat.node')
      .find(item => item.options.key === 'context')
    const userEntry = ctx.slots.entries('conversation.chat.node')
      .find(item => item.options.key === 'user')
    expect(contextEntry?.component).not.toBe(ContextRow)
    expect(userEntry?.component).toBe(UserRow)

    await fiber.dispose()
    expect(contextEntry?.component).toBe(ContextRow)
  })

  it('never wraps Host chrome rows (turn-process / turn-tail)', async () => {
    function ProcessRow() {
      return <div>process</div>
    }
    function TailRow() {
      return <div>tail</div>
    }
    function ContextRow() {
      return <div>context</div>
    }
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'turn-process',
    } as never, ProcessRow as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'turn-tail',
    } as never, TailRow as never)
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'context',
    } as never, ContextRow as never)

    registerOfficialAssistant(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entries = ctx.slots.entries('conversation.chat.node')
    const processEntry = entries.find(item => item.options.key === 'turn-process')
    const tailEntry = entries.find(item => item.options.key === 'turn-tail')
    const contextEntry = entries.find(item => item.options.key === 'context')

    // Host chrome keeps its bare renderer: the wrapper element would defeat
    // ChatView's `.flowItem:empty { display: none }` erasure of a null-rendered
    // summary row, and would push the summary label through the streamed-text
    // reveal engine. Agent output still rides the follow boundary.
    expect(processEntry?.component).toBe(ProcessRow)
    expect(tailEntry?.component).toBe(TailRow)
    expect(contextEntry?.component).not.toBe(ContextRow)

    await fiber.dispose()
    expect(contextEntry?.component).toBe(ContextRow)
  })

  it('leaves a late tool-call native when the playback flow is absent', async () => {
    function LateTool() {
      return <div>late</div>
    }
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    registerOfficialAssistant(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'tool-call',
    } as never, LateTool as never)
    // Slot subscriptions publish registration changes in a microtask.
    await Promise.resolve()
    const entry = ctx.slots.entries('conversation.chat.node').find(item => item.options.key === 'tool-call')
    expect(entry?.component).not.toBe(LateTool)
    const view = render(createElement(entry?.component as FunctionComponent<{ node: { data: { root: object } } }>, {
      node: { data: { root: { callId: '2', name: 'read' } } },
    }))
    expect(view.container.querySelector('[data-entrance]')).toBeNull()
    expect(view.getByText('late')).not.toBeNull()
    await fiber.dispose()
  })

  async function renderRegisteredView(props: AssistantOwner): Promise<HTMLElement> {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' } },
    } as never, (() => null) as never)
    registerOfficialAssistant(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const component = ctx.slots.entries('conversation.chat.node')[0]?.component
    expect(component).toBeTypeOf('function')
    const view = render(createElement(component as FunctionComponent<AssistantOwner>, props))
    // Disposal now updates mounted adapter entries to the official component.
    // Keep the overlay active until the caller has asserted its live behavior.
    pendingDisposals.push(async () => { await fiber.dispose() })
    return view.container
  }

  it('keeps the official assistant renderer when Host config exists without the playback flow', async () => {
    ;(globalThis as Record<string, unknown>)[STREAM_BOOT_GLOBAL] = {
      ...DEFAULT_STREAM_CONFIG,
      mode: 'teleprompter',
      preset: 'silky',
      scrollSpeedPxPerSec: 60,
      maxScrollSpeedPxPerSec: 200,
    }
    const container = await renderRegisteredView(assistantProps('running', [
      { kind: 'text', text: 'hello' },
    ]))
    expect(container.querySelector('[data-entrance]')).toBeNull()
    expect(container.textContent).toContain('hello')
    delete (globalThis as Record<string, unknown>)[STREAM_BOOT_GLOBAL]
  })

  it('keeps the official Markdown renderer when the playback flow is absent', async () => {
    delete (globalThis as Record<string, unknown>)[STREAM_BOOT_GLOBAL]
    const container = await renderRegisteredView(assistantProps('running', [
      { kind: 'text', text: '**hello**' },
    ]))
    expect(container.querySelector('[data-entrance]')).toBeNull()
    await vi.waitFor(() => expect(container.querySelector('strong')?.textContent).toBe('hello'))
  })

  it('fails loudly on a malformed boot global', async () => {
    ;(globalThis as Record<string, unknown>)[STREAM_BOOT_GLOBAL] = { mode: 'diagonal' }
    await expect(renderRegisteredView(assistantProps('running', [
      { kind: 'text', text: 'hello' },
    ]))).rejects.toThrow(/malformed/)
    delete (globalThis as Record<string, unknown>)[STREAM_BOOT_GLOBAL]
  })
})

describe('plugin Config schema', () => {
  it('fills defaults when the overlay config is omitted', () => {
    const resolved = Config({} as never)
    expect(resolved).toEqual(DEFAULT_STREAM_CONFIG)
  })

  it('accepts a full override and rejects invalid values', () => {
    const resolved = Config({
      mode: 'teleprompter',
      preset: 'realtime',
      revealCharsPerSec: 60,
      scrollSpeedPxPerSec: 100,
      maxScrollSpeedPxPerSec: 400,
    })
    expect(resolved).toEqual({
      mode: 'teleprompter',
      preset: 'realtime',
      revealCharsPerSec: 60,
      scrollSpeedPxPerSec: 100,
      maxScrollSpeedPxPerSec: 400,
    })
    expect(() => Config({ mode: 'diagonal' } as never)).toThrow()
    expect(() => Config({ scrollSpeedPxPerSec: 0 } as never)).toThrow()
    expect(() => Config({ maxScrollSpeedPxPerSec: 9000 } as never)).toThrow()
    expect(() => Config({ revealCharsPerSec: 0 } as never)).toThrow()
  })
})

describe('computeQueueReveal', () => {
  it('matches the reference pressure curve for an 80-character backlog', () => {
    const backlog = 80
    const speed = Math.min(600, 90 + Math.pow(backlog, 1.25) * 0.85)
    expect(computeQueueReveal(backlog, 1000 / 60)).toBe(Math.floor(speed / 60))
  })

  it('types one glyph per frame when the queue is small', () => {
    expect(computeQueueReveal(3, 16.67)).toBe(1)
  })

  it('raises the step when the queue is backlogged', () => {
    expect(computeQueueReveal(40, 16.67)).toBe(2)
    expect(computeQueueReveal(80, 16.67)).toBe(4)
  })

  it('carries fractional character debt across short frames', () => {
    const first = computeAdaptiveQueueStep(3, 5, 0)
    expect(first.revealChars).toBe(0)
    const second = computeAdaptiveQueueStep(3, 6, first.debt)
    expect(second.revealChars).toBe(1)
    expect(second.debt).toBeGreaterThanOrEqual(0)
    expect(second.debt).toBeLessThan(1)
  })

  it('never exceeds the backlog', () => {
    expect(computeQueueReveal(2, 1000)).toBe(2)
    expect(computeQueueReveal(0, 16)).toBe(0)
  })

  it('keeps only fractional credit after long frames and a saturated cadence', () => {
    for (const cadenceClamp of [1, 2, 4, 8]) {
      let debt = 1000.25
      for (let frame = 0; frame < 120; frame += 1) {
        const step = computeAdaptiveQueueStep(6000, frame % 2 === 0 ? 500 : 16, debt, 2, {
          ...DEFAULT_STREAM_DEBUG_TUNING,
          cadenceClamp,
        })
        expect(step.revealChars).toBeLessThanOrEqual(cadenceClamp)
        expect(step.debt).toBeGreaterThanOrEqual(0)
        expect(step.debt).toBeLessThan(1)
        debt = step.debt
      }
    }
  })

  it('scales sustained saturated reveal budgets without storing a catch-up burst', () => {
    const integrate = (scale: number): number => {
      let debt = 0
      let total = 0
      for (let frame = 0; frame < 120; frame += 1) {
        const step = computeAdaptiveQueueStep(6000, 1000 / 60, debt, scale)
        total += step.revealChars
        debt = step.debt
      }
      return total
    }
    expect(integrate(0.55)).toBeCloseTo(integrate(1) * 0.55, 0)
    expect(integrate(1)).toBe(120 * DEFAULT_STREAM_DEBUG_TUNING.cadenceClamp)
    const slowed = computeAdaptiveQueueStep(6000, 1000, 0, 0.55)
    const resumed = computeAdaptiveQueueStep(6000, 1000 / 60, slowed.debt)
    expect(resumed.revealChars).toBe(DEFAULT_STREAM_DEBUG_TUNING.cadenceClamp)
    expect(resumed.debt).toBeLessThan(1)
  })

  it('applies live diagnostics tuning without changing the production default', () => {
    const baseline = computeAdaptiveQueueStep(80, 1000 / 60, 0)
    expect(computeAdaptiveQueueStep(80, 1000 / 60, 0, 1, DEFAULT_STREAM_DEBUG_TUNING)).toEqual(baseline)
    // Compare reveal speed below the configured cadence ceiling. At the
    // production 4-char ceiling both rates correctly saturate at four.
    const tuning = { ...DEFAULT_STREAM_DEBUG_TUNING, cadenceClamp: 20 }
    const uncapped = computeAdaptiveQueueStep(80, 1000 / 60, 0, 1, tuning)
    const tuned = computeAdaptiveQueueStep(80, 1000 / 60, 0, 1, {
      ...tuning,
      queuePressure: 1.6,
      revealScale: 1.4,
      maxRevealCps: 900,
    })

    expect(tuned.speedCps).toBeGreaterThan(uncapped.speedCps)
    expect(tuned.revealChars).toBeGreaterThan(uncapped.revealChars)
    expect(tuned.revealChars).toBeLessThan(tuning.cadenceClamp)
  })
})

describe('computeSettleDrain', () => {
  it('drains ordinary backlog within the settle window', () => {
    const config = PRESET_CONFIG.balanced
    const ordinary = computeSettleDrain(config, { backlog: 200, inputActive: false, settling: true })
    expect(ordinary).toBeGreaterThanOrEqual(config.flushCps)
    expect(ordinary).toBeLessThanOrEqual(config.maxFlushCps)
  })

  it('climbs past the settle window to close a backlog beyond the lag ceiling', () => {
    const config = PRESET_CONFIG.balanced
    const lagged = computeSettleDrain(config, { backlog: 2000, inputActive: false, settling: true })
    const ordinary = computeSettleDrain(config, { backlog: 50, inputActive: false, settling: true })
    expect(lagged).toBeGreaterThan(ordinary)
    expect(lagged).toBe(config.maxFlushCps)
    // Ceiling drain alone closes a 2000-char backlog within two seconds:
    // the whole reply drains at maxFlushCps while the overflow pays for itself.
    expect((2000 - BACKLOG_CHAR_CEILING) * 1000 / BACKLOG_SECOND_CEILING).toBeGreaterThan(config.maxFlushCps)
  })

  it('stays in the settle band while input is still active or not yet settling', () => {
    const config = PRESET_CONFIG.balanced
    expect(computeSettleDrain(config, { backlog: 5000, inputActive: true, settling: false })).toBe(0)
    expect(computeSettleDrain(config, { backlog: 5000, inputActive: false, settling: false })).toBe(0)
  })
})

describe('computeCompletionDrain', () => {
  it('closes every producer-complete backlog within its configured deadline', () => {
    const config = PRESET_CONFIG.balanced
    expect(computeCompletionDrain(config, 32)).toBeGreaterThanOrEqual(config.flushCps)
    for (const backlog of [32, 128, 512, 2048]) {
      const deadlineMs = Math.min(
        config.settleDrainMaxMs,
        Math.max(config.settleDrainMinMs, backlog * 8),
      )
      const drainMs = backlog * 1000 / computeCompletionDrain(config, backlog)
      expect(drainMs).toBeLessThanOrEqual(deadlineMs)
    }
  })
})

describe('computeFollowStep', () => {
  it('bridges revealed characters into a continuous predictive wrap target', () => {
    const phase = new FollowRevealPhaseTracker({
      seedCharsPerLine: 50,
      seedLineHeightPx: 28,
    })

    expect(phase.advance(400, 0).targetPx).toBe(400)
    expect(phase.advance(400, 25).targetPx).toBeCloseTo(414, 5)
    const beforeWrap = phase.advance(400, 49).targetPx
    const afterWrap = phase.advance(428, 50).targetPx
    expect(afterWrap - beforeWrap).toBeLessThan(1)

    // An early paragraph/layout wrap updates the estimate instead of locking
    // the tracker to the original 50-character seed.
    phase.advance(428, 89)
    const earlyWrap = phase.advance(456, 90)
    expect(earlyWrap.charsPerLine).toBeLessThan(50)
    expect(earlyWrap.phase).toBe(0)
  })

  it('does not treat sub-line floor rounding as a new wrap', () => {
    const phase = new FollowRevealPhaseTracker({
      seedCharsPerLine: 50,
      seedLineHeightPx: 28,
    })
    phase.advance(400, 0)
    const before = phase.advance(400, 25)
    const after = phase.advance(401, 26)

    expect(after.phase).toBeGreaterThan(before.phase)
    expect(after.lineHeightPx).toBe(28)
  })

  it('resets phase sampling across non-text flow growth', () => {
    const phase = new FollowRevealPhaseTracker({
      seedCharsPerLine: 50,
      seedLineHeightPx: 28,
    })
    phase.advance(400, 0)
    phase.advance(428, 50)
    phase.advance(456, 50)
    const afterTextWrap = phase.advance(484, 90)

    expect(afterTextWrap.charsPerLine).toBeLessThan(50)
  })

  it('keeps trajectory position continuous across early and late wraps', () => {
    const phase = new FollowRevealPhaseTracker({
      seedCharsPerLine: 50,
      seedLineHeightPx: 28,
    })
    const wrapAt = [50, 90, 150]
    let floorPx = 400
    let positionPx = 352
    let velocityPxPerMs = 0.34
    let previousPositionPx = positionPx
    let maxAdvancePx = 0

    for (let revealedChars = 0; revealedChars <= 170; revealedChars += 5) {
      if (wrapAt.includes(revealedChars)) floorPx += 28
      const target = phase.advance(floorPx, revealedChars)
      const step = computeFollowTrajectoryStep(16, {
        positionPx,
        velocityPxPerMs,
        targetPx: target.targetPx,
        targetVelocityPxPerMs: 0.34,
        minLagPx: 40,
        maxLagPx: 71,
        paintFloorPx: floorPx,
      })
      positionPx = step.positionPx
      velocityPxPerMs = step.velocityPxPerMs
      maxAdvancePx = Math.max(maxAdvancePx, positionPx - previousPositionPx)
      previousPositionPx = positionPx
      expect(step.shiftPx).toBeGreaterThanOrEqual(0)
      expect(step.shiftPx).toBeLessThanOrEqual(71)
    }

    expect(maxAdvancePx).toBeLessThan(8)
  })

  it('keeps effective scroll velocity continuous across repeated line wraps', () => {
    let targetPx = 100
    let positionPx = targetPx - 7
    let velocityPxPerMs = 28 / (7 * 16)
    let targetVelocityPxPerMs = velocityPxPerMs
    const positions: number[] = []

    for (let frame = 0; frame < 80; frame += 1) {
      if (frame > 0 && frame % 7 === 0) {
        targetPx += 28
        targetVelocityPxPerMs = 28 / (7 * 16)
      }
      const step = computeFollowTrajectoryStep(16, {
        positionPx,
        velocityPxPerMs,
        targetPx,
        targetVelocityPxPerMs,
        minLagPx: 7,
        maxLagPx: 47,
      })
      positionPx = step.positionPx
      velocityPxPerMs = step.velocityPxPerMs
      positions.push(positionPx)
      expect(step.shiftPx).toBeGreaterThanOrEqual(7)
      expect(step.shiftPx).toBeLessThanOrEqual(47)
    }

    const velocities = positions.slice(1).map((position, index) => (position - positions[index]!) / 16)
    const changes = velocities.slice(16).map((velocity, index) => Math.abs(velocity - velocities[index + 15]!))
    const sortedChanges = [...changes].sort((left, right) => left - right)
    expect(sortedChanges[Math.ceil(sortedChanges.length * 0.95) - 1]).toBeLessThanOrEqual(0.025)
    expect(Math.max(...changes)).toBeLessThanOrEqual(0.075)
  })

  it('uses the velocity budget when a narrow fast stream needs more than 8px per frame', () => {
    const velocityPxPerMs = 26 / 50
    const step = computeFollowTrajectoryStep(16, {
      positionPx: 100,
      velocityPxPerMs,
      targetPx: 150,
      targetVelocityPxPerMs: velocityPxPerMs,
      minLagPx: 31,
      maxLagPx: 71,
    })

    expect(step.positionPx - 100).toBeGreaterThan(8)
    expect(step.positionPx - 100).toBeCloseTo(step.velocityPxPerMs * 16, 5)
  })

  it('does not reverse position when an estimated phase target is corrected downward', () => {
    const step = computeFollowTrajectoryStep(16, {
      positionPx: 120,
      velocityPxPerMs: 0.2,
      targetPx: 145,
      targetVelocityPxPerMs: 0.2,
      minLagPx: 30,
      maxLagPx: 60,
      paintFloorPx: 140,
    })

    expect(step.positionPx).toBeGreaterThanOrEqual(120)
  })

  it('never allows a lag band to exceed its paint-space ceiling', () => {
    const step = computeFollowTrajectoryStep(16, {
      positionPx: 60,
      velocityPxPerMs: 0,
      targetPx: 100,
      targetVelocityPxPerMs: 0,
      minLagPx: 40,
      maxLagPx: 10,
      paintFloorPx: 100,
    })

    expect(step.shiftPx).toBeLessThanOrEqual(10)
  })

  it('reserves reveal headroom without changing the spring constants', () => {
    expect(computeFollowRevealScale(0, 48)).toBe(1)
    expect(computeFollowRevealScale(28, 48)).toBeLessThan(0.75)
    expect(computeFollowRevealScale(48, 48)).toBe(0.55)
    expect(computeFollowRevealScale(20, 48, true)).toBe(0.55)
    expect(computeFollowRevealScale(200, Number.POSITIVE_INFINITY)).toBe(1)
  })

  it('holds one wrap impulse of runway at every active speed, none while idle', () => {
    // Idle (no reveal) holds nothing; any active cadence gets at least one
    // full wrapped line of absorption room — a narrower natural gap would
    // otherwise turn every slow-cadence wrap into an instant catch-up step.
    expect(computeFollowReserve(10)).toBe(0)
    expect(computeFollowReserve(35)).toBeGreaterThanOrEqual(FOLLOW_RESERVE_MIN_PX)
    expect(computeFollowReserve(91)).toBeGreaterThanOrEqual(FOLLOW_RESERVE_MIN_PX)
    expect(computeFollowReserve(600)).toBe(FOLLOW_STATUS_RUNWAY_PX)
    expect(computeFollowReserve(300)).toBeGreaterThanOrEqual(FOLLOW_RESERVE_MIN_PX)
    expect(computeFollowReserve(300)).toBeLessThan(FOLLOW_STATUS_RUNWAY_PX)
  })

  it('matches the reference K=130 C=24 four-substep spring', () => {
    const frameMs = 1000 / 60
    const lag = 28
    const subDt = frameMs / 1000 / 4
    let expectedLag = lag
    let expectedVelocity = 0
    for (let substep = 0; substep < 4; substep += 1) {
      const acceleration = 130 * expectedLag - 24 * expectedVelocity
      expectedVelocity += acceleration * subDt
      expectedLag -= expectedVelocity * subDt
    }
    const step = computeFollowStep(frameMs, { lag, speedEma: FOLLOW_SPEED_REF_CPS })

    expect(step.advancePx).toBeCloseTo(lag - expectedLag, 5)
  })

  it('uses live diagnostics spring and backpressure tuning', () => {
    const baseline = computeFollowStep(16, { lag: 28, speedEma: FOLLOW_SPEED_REF_CPS })
    const stiffer = computeFollowStep(16, { lag: 28, speedEma: FOLLOW_SPEED_REF_CPS }, {
      ...DEFAULT_STREAM_DEBUG_TUNING,
      springStiffness: 260,
    })
    const lowerBackpressure = computeFollowRevealScale(48, 48, false, {
      ...DEFAULT_STREAM_DEBUG_TUNING,
      backpressureMinScale: 0.35,
    })

    expect(stiffer.advancePx).toBeGreaterThan(baseline.advancePx)
    expect(lowerBackpressure).toBe(0.35)
  })

  it('eases a wrap-sized lag instead of snapping it', () => {
    const step = computeFollowStep(16, { lag: 28, speedEma: FOLLOW_SPEED_REF_CPS })
    expect(step.advancePx).toBeGreaterThan(0.5)
    expect(step.advancePx).toBeLessThan(28)
    expect(step.lerpStep).toBeLessThan(0.25)
  })

  it('accelerates proportionally when the physical lag is high', () => {
    const slow = computeFollowStep(16, { lag: 28, speedEma: 20 })
    const fast = computeFollowStep(16, { lag: 200, speedEma: 120 })
    expect(fast.advancePx).toBeGreaterThan(slow.advancePx)
    expect(fast.lerpStep).toBeCloseTo(slow.lerpStep, 10)
  })

  it('settles when lag is already closed', () => {
    const step = computeFollowStep(16, { lag: 0, speedEma: 80 })
    expect(step.advancePx).toBe(0)
    expect(step.lerpStep).toBe(0)
  })

  it('closes a line-sized lag over many frames instead of one hop', () => {
    let lag = 28
    for (let frame = 0; frame < 10; frame += 1) {
      const step = computeFollowStep(16, { lag, speedEma: FOLLOW_SPEED_REF_CPS })
      expect(step.advancePx).toBeLessThan(8)
      lag -= step.advancePx
    }
    expect(lag).toBeGreaterThan(8)
    expect(lag).toBeLessThan(24)
  })

  it('tracks the reference response consistently across high-refresh frame rates', () => {
    const simulate = (frameMs: number): number => {
      let lag = 28
      let velocityPxPerSec = 0
      for (let elapsed = 0; elapsed < 500; elapsed += frameMs) {
        const dt = Math.min(frameMs, 500 - elapsed)
        const step = computeFollowStep(dt, {
          lag,
          speedEma: FOLLOW_SPEED_REF_CPS,
          velocityPxPerSec,
        })
        lag -= step.advancePx
        velocityPxPerSec = step.velocityPxPerSec
      }
      return lag
    }
    const at60Fps = simulate(1000 / 60)
    expect(simulate(1000 / 120)).toBeCloseTo(at60Fps, 0)
  })

  it('limits a stalled frame to the reference 32ms physics interval', () => {
    const lag = 200
    const stalled = computeFollowStep(250, { lag, speedEma: FOLLOW_SPEED_REF_CPS })
    const reference = computeFollowStep(32, { lag, speedEma: FOLLOW_SPEED_REF_CPS })
    expect(stalled.advancePx).toBeCloseTo(reference.advancePx, 8)
  })
})
