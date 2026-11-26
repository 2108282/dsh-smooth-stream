import { act, cleanup, render } from '@testing-library/react'
import { createElement, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProgressiveDomText } from '../src/client/useProgressiveDomText.ts'
import { streamRelay } from '../src/client/streamRelay.ts'
import { setForegroundRecoveryDelay } from '../src/client/backgroundRecovery.ts'
import type { BackgroundRecovery } from '../src/settings.ts'

let frames: Map<number, FrameRequestCallback>
let time: number
let next: number
async function paint(count = 1) {
  for (let index = 0; index < count; index++) await act(async () => {
    expect(frames.size).toBeLessThanOrEqual(1)
    const batch = [...frames.values()]
    frames.clear()
    time += 16
    for (const callback of batch) callback(time)
  })
}
async function signal(hidden: boolean) {
  await act(async () => { window.dispatchEvent(new Event(hidden ? 'dsha:background' : 'dsha:foreground')) })
}
function Probe({ mode = 'catch-up', settled, pending, epoch, speed, paused = false }: {
  mode?: BackgroundRecovery
  paused?: boolean
  settled: () => void
  pending?: (value: boolean) => void
  epoch: (value: number | undefined) => void
  speed: { current: number }
}) {
  const root = useRef<HTMLDivElement>(null)
  useProgressiveDomText(root, true, true, speed, settled, pending, paused, mode,
    '["dom-batches",1]', undefined, true, epoch)
  return createElement('div', { ref: root },
    createElement('div', { 'data-chat-call-id': 'a' }, 'a'),
    createElement('div', { 'data-chat-call-id': 'b' }, 'b'.repeat(70)))
}
function setup(mode: BackgroundRecovery = 'catch-up') {
  const settled = vi.fn()
  const pending = vi.fn()
  const epoch = vi.fn()
  const speed = { current: 35 }
  const view = render(createElement(Probe, { mode, settled, pending, epoch, speed }))
  const a = view.container.querySelector<HTMLElement>('[data-chat-call-id="a"]')!
  const b = view.container.querySelector<HTMLElement>('[data-chat-call-id="b"]')!
  return { ...view, a, b, aText: a.firstChild as Text, bText: b.firstChild as Text, settled, pending, epoch, speed }
}
beforeEach(() => {
  time = 0; next = 0; frames = new Map()
  vi.stubGlobal('performance', { now: () => time })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  setForegroundRecoveryDelay(0)
})
afterEach(() => { cleanup(); streamRelay.clearAll(); setForegroundRecoveryDelay(0); vi.unstubAllGlobals() })

describe('recovery DOM playback batches', () => {
  it.each(['catch-up', 'replay'] as const)('isolates repeated earlier appends and new nodes across %s batches without settling between them', async mode => {
    const view = setup(mode)
    await paint(5)
    await signal(true)
    await signal(false)
    expect(view.epoch.mock.calls.map(call => call[0])).toEqual([0])
    const secondBefore = view.b.textContent!
    const c = document.createElement('span')
    c.textContent = 'c'.repeat(30)
    await act(async () => { view.aText.data = 'a'.repeat(20); view.a.parentElement!.append(c) })
    expect(view.a.textContent).toBe('a')
    await paint(2)
    expect(view.a.textContent).toBe('a')
    expect(view.b.textContent!.length).toBeGreaterThan(secondBefore.length)
    for (let index = 0; index < 150 && view.epoch.mock.calls.length < 2; index++) await paint()
    expect(view.b.textContent).toBe('b'.repeat(70))
    expect(view.epoch.mock.calls.map(call => call[0])).toEqual([0, 1])
    expect(view.settled).not.toHaveBeenCalled()
    expect(view.speed.current).not.toBe(35)
    expect(view.b.style.visibility).not.toBe('hidden')
    await paint()
    expect(view.a.textContent!.length).toBeGreaterThan(1)
    await act(async () => { view.aText.data = 'a'.repeat(40) })
    for (let index = 0; index < 150 && c.textContent!.length === 0; index++) await paint()
    expect(c.textContent!.length).toBeGreaterThan(0)
    expect(view.a.textContent).toBe('a'.repeat(20))
    expect(view.b.style.visibility).not.toBe('hidden')
    expect(view.settled).not.toHaveBeenCalled()
    for (let index = 0; index < 150 && view.epoch.mock.calls.length < 3; index++) await paint()
    expect(c.textContent).toBe('c'.repeat(30))
    expect(view.epoch.mock.calls.map(call => call[0])).toEqual([0, 1, 2])
    expect(view.pending.mock.calls.every(call => call[0])).toBe(true)
    await paint(150)
    expect(view.a.textContent).toBe('a'.repeat(40))
    expect(view.settled).toHaveBeenCalledTimes(1)
    expect(view.epoch.mock.calls.map(call => call[0])).toEqual([0, 1, 2, undefined])
    expect(frames.size).toBe(0)
  })

  it('freezes a fresh source boundary after background reentry without replaying a replaced emoji suffix', async () => {
    const view = setup()
    await paint(5)
    await signal(true)
    await signal(false)
    await act(async () => { view.aText.data = 'a😀'.repeat(40) })
    await paint(2)
    await signal(true)
    expect(view.epoch.mock.calls.at(-1)?.[0]).toBeUndefined()
    expect(frames.size).toBe(0)
    await act(async () => { view.aText.data = 'a😀replacement' })
    await signal(false)
    expect(view.epoch.mock.calls.at(-1)?.[0]).toBe(0)
    await paint(150)
    expect(view.a.textContent).toBe('a😀replacement')
    expect(view.b.textContent).toBe('b'.repeat(70))
    expect(view.a.textContent).not.toContain('😀a😀')
    expect(frames.size).toBe(0)
  })

  it('invalidates active replacement and truncation boundaries while retaining authoritative text', async () => {
    const view = setup()
    await paint(5)
    await signal(true)
    await signal(false)
    await act(async () => { view.bText.data = '😀'.repeat(25) })
    await paint(2)
    await act(async () => { view.bText.data = '😀短' })
    await paint(80)
    expect(view.b.textContent).toBe('😀短')
    expect([...view.b.textContent!]).toEqual(['😀', '短'])
    expect(view.settled).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
  })

  it('keeps a previously visible later call visible when an earlier call grows in the background', async () => {
    const view = setup()
    await paint(5)
    expect(view.b.textContent!.length).toBeGreaterThan(0)
    expect(view.b.style.visibility).not.toBe('hidden')
    await signal(true)
    await act(async () => { view.aText.data = 'a'.repeat(20) })
    await signal(false)
    expect(view.b.style.visibility).not.toBe('hidden')
    await paint(3)
    expect(view.b.style.visibility).not.toBe('hidden')
    await paint(100)
    expect(view.a.textContent).toBe('a'.repeat(20))
    expect(view.b.textContent).toBe('b'.repeat(70))
  })

  it('keeps presented calls visible while another recovery root pauses playback', async () => {
    const view = setup()
    await paint(5)
    await signal(true)
    await signal(false)
    const shown = view.b.textContent
    expect(shown!.length).toBeGreaterThan(0)
    view.rerender(createElement(Probe, { paused: true, settled: view.settled, pending: view.pending, epoch: view.epoch, speed: view.speed }))
    await act(async () => { view.aText.data = 'a'.repeat(30) })
    expect(view.b.style.visibility).not.toBe('hidden')
    await paint(5)
    expect(view.b.textContent).toBe(shown)
    expect(view.b.style.visibility).not.toBe('hidden')
    expect(view.settled).not.toHaveBeenCalled()
    view.rerender(createElement(Probe, { paused: false, settled: view.settled, pending: view.pending, epoch: view.epoch, speed: view.speed }))
    await paint(100)
    expect(view.b.textContent).toBe('b'.repeat(70))
    expect(view.a.textContent).toBe('a'.repeat(30))
    expect(view.settled).toHaveBeenCalledTimes(1)
  })

  it('keeps latest recovery immediate without publishing playback batches', async () => {
    const view = setup('latest')
    await paint(5)
    await signal(true)
    await signal(false)
    await paint(3)
    expect(view.a.textContent).toBe('a')
    expect(view.b.textContent).toBe('b'.repeat(70))
    expect(view.epoch).not.toHaveBeenCalled()
  })
})
