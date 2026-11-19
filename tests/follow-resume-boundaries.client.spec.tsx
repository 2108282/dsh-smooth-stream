import { act, cleanup, render } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debugRuntime } from '../src/client/debugRuntime.ts'
import { useConversationFollow } from '../src/client/teleprompterGlide.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'

interface Model {
  base: number
  viewport: number
  measurable: boolean
  port: HTMLElement
  row: HTMLElement
  transcript: HTMLElement
  status: HTMLElement
  spacer: HTMLElement
}
let now: number
let nextFrame: number
let frames: Map<number, FrameRequestCallback>
let settled: number
const px = (value: string): number => [...value.matchAll(/(-?[\d.]+)px/g)]
  .reduce((sum, match) => sum + Number(match[1]), 0)

function Arm({ active, entrance = false, entranceHeight = 0 }: { active: boolean; entrance?: boolean; entranceHeight?: number }) {
  const root = useRef<HTMLDivElement>(null)
  const speed = useRef(600)
  const entranceExtent = useRef<number | null>(entranceHeight > 0 ? entranceHeight : null)
  useConversationFollow(root, active, speed, undefined, true, entrance, () => { settled++ }, undefined, entranceExtent)
  return <div ref={root}>A live answer</div>
}

function Surface({ modelRef, active, entrance = false, generation = 0, entranceHeight = 0, userRow = false }: {
  modelRef: { current: Model | null }
  active: boolean
  entrance?: boolean
  generation?: number
  entranceHeight?: number
  userRow?: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const port = root.current!
    const model: Model = {
      port,
      base: 800,
      viewport: 200,
      measurable: true,
      row: port.querySelector('[data-chat-anchor-key]')!,
      transcript: port.querySelector('[data-chat-transcript]')!,
      status: port.querySelector('[data-chat-turn-status]')!,
      spacer: port.querySelector('[data-chat-turn-spacer]')!,
    }
    modelRef.current = model
    let top = 0
    const height = () => model.base + px(model.transcript.style.paddingBottom)
      + px(model.status.style.marginTop) + px(model.spacer.style.height)
    Object.defineProperty(port, 'clientHeight', { configurable: true, get: () => model.measurable ? model.viewport : 0 })
    Object.defineProperty(port, 'scrollHeight', { configurable: true, get: height })
    Object.defineProperty(port, 'scrollTop', {
      configurable: true,
      get: () => Math.max(0, Math.min(top, height() - port.clientHeight)),
      set: value => { top = Math.max(0, Math.min(Number(value), height() - port.clientHeight)) },
    })
    vi.spyOn(port, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, bottom: port.clientHeight, height: port.clientHeight }) as DOMRect)
    vi.spyOn(model.row, 'getBoundingClientRect').mockImplementation(() => {
      const bottom = model.base - port.scrollTop + shift(model.transcript) + shift(model.row)
      return { top: bottom - 40, bottom, height: 40 } as DOMRect
    })
    vi.spyOn(model.transcript, 'getBoundingClientRect').mockImplementation(() => {
      const top = -port.scrollTop + shift(model.transcript)
      return { top, bottom: top + model.base + px(model.transcript.style.paddingBottom), height: model.base + px(model.transcript.style.paddingBottom) } as DOMRect
    })
    vi.spyOn(model.status, 'getBoundingClientRect').mockImplementation(() => {
      const top = model.base + px(model.status.style.marginTop) - port.scrollTop + shift(model.transcript)
      return model.measurable ? { top, bottom: top + 20, height: 20 } as DOMRect : { top: 0, bottom: 0, height: 0 } as DOMRect
    })
  }, [modelRef])
  return <div ref={root} data-conversation-scroll>
    <div data-chat-transcript style={{ paddingBottom: '13px', minHeight: '29px' }}>
      <div data-chat-anchor-key="answer" data-chat-flow-kind="assistant"><Arm key={generation} active={active} entrance={entrance} entranceHeight={entranceHeight} /></div>
      {userRow ? <div data-chat-anchor-key="user" data-chat-flow-kind="user">Prompt</div> : null}
      <div data-chat-turn-status role="status" style={{ marginTop: '7px' }}>Working</div>
    </div>
    <div data-chat-turn-spacer style={{ height: '48px' }} />
  </div>
}

function shift(element: HTMLElement): number {
  return Number(/translate3d\(0(?:px)?,\s*(-?[\d.]+)px,\s*0(?:px)?\)/.exec(element.style.transform)?.[1] ?? 0)
}

async function paint(count = 1, delta = 16) {
  for (let index = 0; index < count; index++) await act(async () => {
    now += delta
    const batch = [...frames.values()]
    frames.clear()
    for (const callback of batch) callback(now)
  })
}

async function lifecycle(hidden: boolean) {
  await act(async () => window.dispatchEvent(new Event(hidden ? 'dsha:background' : 'dsha:foreground')))
}

beforeEach(() => {
  now = 0
  nextFrame = 0
  settled = 0
  frames = new Map()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.stubGlobal('performance', { now: () => now })
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

describe('follow recovery boundary regressions', () => {
  it('keeps the original follow intent across hide-show-hide before a measurable RAF', async () => {
    const modelRef = { current: null as Model | null }
    const view = render(<Surface modelRef={modelRef} active />)
    const model = modelRef.current!
    await paint(20)
    expect(model.port.scrollTop).toBe(model.port.scrollHeight - model.port.clientHeight)

    await lifecycle(true)
    model.measurable = false
    await lifecycle(false)
    // Hide again before any resumed animation frame can establish new geometry.
    model.base += 120
    await lifecycle(true)
    model.base += 160
    model.measurable = true
    await lifecycle(false)
    await paint(80)

    expect(model.port.scrollTop).toBe(model.port.scrollHeight - model.port.clientHeight)
    expect(model.port.hasAttribute('data-follow-owned')).toBe(true)
    expect(model.status.textContent).toBe('Working')
    view.unmount()
  })

  it('keeps the first-frame policy identical after zero or five seconds of foreground idle', async () => {
    const run = async (idleMs: number) => {
      const modelRef = { current: null as Model | null }
      const view = render(<Surface modelRef={modelRef} active />)
      const model = modelRef.current!
      await paint(20)
      view.rerender(<Surface modelRef={modelRef} active={false} />)
      await paint(200)
      settled = 0
      now += idleMs
      model.base += 240
      view.rerender(<Surface modelRef={modelRef} active entrance generation={1} entranceHeight={240} userRow />)
      await paint()
      const firstFrame = {
        settled: settled,
        margin: model.status.style.marginTop,
        padding: model.transcript.style.paddingBottom,
        shift: shift(model.transcript),
        scrollTop: model.port.scrollTop,
        owned: model.port.hasAttribute('data-follow-owned'),
      }
      await paint(100)
      expect(model.port.scrollTop).toBe(model.port.scrollHeight - model.port.clientHeight)
      expect(model.status.textContent).toBe('Working')
      view.unmount()
      await act(async () => {})
      return firstFrame
    }

    const immediate = await run(0)
    const afterIdle = await run(5000)
    expect(afterIdle).toEqual(immediate)
  })
})
