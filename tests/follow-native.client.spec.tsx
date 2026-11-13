import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FollowHost } from '../src/client/FollowHost.tsx'
import { notifyFollowCommit, shiftSurfacesOf } from '../src/client/teleprompterGlide.ts'
import { debugRuntime } from '../src/client/debugRuntime.ts'

const FAKE = ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] as const
const shiftOf = (element: HTMLElement): number => Number(
  /translate3d\(0(?:px)?,\s*(-?[\d.]+)px,\s*0(?:px)?\)/.exec(element.style.transform)?.[1] ?? 0,
)
const px = (value: string): number => Number.parseFloat(value) || 0

function Probe({ active = true }: { active?: boolean }) {
  const speed = useRef(300)
  return <FollowHost active={active} speedCpsRef={speed}>streaming native row</FollowHost>
}

/** ChatView column -> renderer contents seat -> process group -> member flow. */
function NativeFlow({ active = true, status = true }: { active?: boolean, status?: boolean }) {
  return (
    <div data-conversation-scroll>
      <div data-chat-flow data-native-column>
        <div data-slot="conversation.chat.flow" style={{ display: 'contents' }}>
          <div data-chat-flow-key="user" data-chat-anchor-key="user" data-chat-flow-kind="user">prompt</div>
          <div data-chat-group-key="process" data-chat-anchor-key="group:process" data-chat-flow-key="process">
            <div data-step-process-body>
              <div data-step-process-content data-chat-flow>
                <div data-chat-flow-key="assistant" data-chat-anchor-key="assistant" data-chat-flow-kind="assistant">
                  <div data-slot="conversation.chat.node"><Probe active={active} /></div>
                </div>
              </div>
            </div>
          </div>
          <div data-foreign-row>extension row</div>
          {status && <div data-chat-running><span role="status">running</span></div>}
        </div>
        <div data-text-interaction-surface aria-hidden="true" />
      </div>
      <div data-composer-seat>composer</div>
    </div>
  )
}

function geometry(container: HTMLElement) {
  const port = container.querySelector<HTMLElement>('[data-conversation-scroll]')!
  const column = container.querySelector<HTMLElement>('[data-native-column]')!
  const status = container.querySelector<HTMLElement>('[data-chat-running]')!
  const composer = container.querySelector<HTMLElement>('[data-composer-seat]')!
  const surfaces = shiftSurfacesOf(port)
  let height = 500
  Object.defineProperty(port, 'clientHeight', { configurable: true, value: 100 })
  Object.defineProperty(port, 'scrollHeight', {
    configurable: true,
    get: () => height + (status.isConnected ? px(status.style.marginTop) : 0)
      + surfaces.reduce((sum, surface) => sum + px(surface.style.marginBottom), 0)
      + px(column.style.paddingBottom),
  })
  for (const surface of surfaces) {
    vi.spyOn(surface, 'getBoundingClientRect').mockImplementation(() => ({
      top: -port.scrollTop + shiftOf(surface),
      bottom: 80 - px(status.style.marginTop) + shiftOf(surface),
      height: 32,
      width: 200,
    }) as DOMRect)
  }
  vi.spyOn(status, 'getBoundingClientRect').mockImplementation(() => ({
    top: 96 + px(status.style.marginTop), bottom: 122 + px(status.style.marginTop),
  }) as DOMRect)
  vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({ top: 180, bottom: 260 } as DOMRect)
  port.scrollTop = 400
  return { port, column, status, surfaces, grow: (delta: number) => { height += delta } }
}

beforeEach(() => { vi.useFakeTimers({ toFake: [...FAKE] }) })
afterEach(() => {
  cleanup()
  debugRuntime.resetRuntime()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('native Chat flow follow', () => {
  it('selects real outer rows through contents seats without shifting group members or chrome', () => {
    const view = render(<NativeFlow active={false} />)
    const port = view.container.querySelector<HTMLElement>('[data-conversation-scroll]')!
    const surfaces = shiftSurfacesOf(port)
    expect(surfaces.map(row => row.getAttribute('data-chat-flow-key') ?? 'foreign')).toEqual([
      'user', 'process', 'foreign',
    ])
    expect(surfaces).not.toContain(view.container.querySelector('[data-chat-running]'))
    expect(surfaces).not.toContain(view.container.querySelector('[data-slot="conversation.chat.flow"]'))
    expect(surfaces).not.toContain(view.container.querySelector('[data-chat-flow-key="assistant"]'))
  })

  it('compensates a wrap committed inside a nested group before paint and hands reader ownership back', async () => {
    const view = render(<NativeFlow />)
    const { port, column, status, surfaces, grow } = geometry(view.container)
    await act(() => vi.advanceTimersByTimeAsync(240))
    const before = -port.scrollTop + shiftOf(surfaces[0]!)
    grow(28)
    act(() => { notifyFollowCommit(view.container.querySelector('[data-chat-flow-key="assistant"]')) })
    const afterCommit = -port.scrollTop + shiftOf(surfaces[0]!)
    expect(Math.abs(afterCommit - before)).toBeLessThanOrEqual(4)
    expect(port.scrollTop).toBe(port.scrollHeight - port.clientHeight)
    for (const row of surfaces) expect(shiftOf(row)).toBeCloseTo(shiftOf(surfaces[0]!), 6)
    expect(column.style.transform).toBe('')
    expect(status.style.transform).toBe('')
    expect((view.container.querySelector('[data-chat-flow-key="assistant"]') as HTMLElement).style.transform).toBe('')
    expect((view.container.querySelector('[data-slot="conversation.chat.flow"]') as HTMLElement).style.transform).toBe('')

    fireEvent.wheel(port, { deltaY: -1 })
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(port.hasAttribute('data-follow-owned')).toBe(false)
    for (const row of surfaces) expect(row.style.transform).toBe('')
    expect(status.style.marginTop).toBe('')
    const readerTop = port.scrollTop
    grow(28)
    await act(() => vi.advanceTimersByTimeAsync(120))
    expect(port.scrollTop).toBe(readerTop)
  })

  it('corrects nested group child-list commits through the renderer contents seat', async () => {
    const view = render(<NativeFlow />)
    const { port, surfaces, grow } = geometry(view.container)
    await act(() => vi.advanceTimersByTimeAsync(240))
    const before = -port.scrollTop + shiftOf(surfaces[0]!)
    grow(28)
    await act(async () => {
      const member = view.container.querySelector('[data-chat-flow-key="assistant"]')!
      member.append(document.createElement('span'))
    })
    expect(port.scrollTop).toBe(port.scrollHeight - port.clientHeight)
    expect(Math.abs(-port.scrollTop + shiftOf(surfaces[0]!) - before)).toBeLessThanOrEqual(4)
  })

  it('observes the outer column and actual tail while nested seats can change before paint', async () => {
    const observers: { callback: ResizeObserverCallback, targets: Set<Element>, disconnect: ReturnType<typeof vi.fn> }[] = []
    class Observer {
      readonly record
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, targets: new Set<Element>(), disconnect: vi.fn() }
        observers.push(this.record)
      }
      observe(target: Element) { this.record.targets.add(target) }
      unobserve(target: Element) { this.record.targets.delete(target) }
      disconnect() { this.record.disconnect(); this.record.targets.clear() }
    }
    vi.stubGlobal('ResizeObserver', Observer)
    const view = render(<NativeFlow />)
    const { column, surfaces } = geometry(view.container)
    await act(() => vi.advanceTimersByTimeAsync(32))
    expect(observers.some(observer => observer.targets.has(column))).toBe(true)
    expect(observers.some(observer => observer.targets.has(surfaces.at(-1)!))).toBe(true)
    expect(observers.some(observer => [...observer.targets].some(target => target.getAttribute('data-slot') === 'conversation.chat.flow'))).toBe(false)
    view.unmount()
    await act(() => vi.advanceTimersByTimeAsync(2400))
    expect(observers.every(observer => observer.disconnect.mock.calls.length > 0)).toBe(true)
  })

  it('keeps the growth baseline when callback identity changes and cancels pending notification on unmount', async () => {
    let callback: ResizeObserverCallback = () => {}
    const disconnect = vi.fn()
    class Observer {
      constructor(next: ResizeObserverCallback) { callback = next }
      observe() {}
      disconnect() { disconnect() }
    }
    vi.stubGlobal('ResizeObserver', Observer)
    const first = vi.fn()
    const second = vi.fn()
    const speed = { current: 35 }
    const view = render(<FollowHost active={false} speedCpsRef={speed} onGrowth={first}>row</FollowHost>)
    const notify = (height: number) => act(() => { callback([
      { contentRect: { height } } as ResizeObserverEntry,
    ], {} as ResizeObserver) })
    notify(32)
    view.rerender(<FollowHost active={false} speedCpsRef={speed} onGrowth={second}>row</FollowHost>)
    notify(64)
    notify(80)
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledExactlyOnceWith(48)
    notify(120)
    view.unmount()
    await act(() => vi.advanceTimersByTimeAsync(16))
    expect(second).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
