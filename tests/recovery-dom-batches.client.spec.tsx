import { act, cleanup, render } from '@testing-library/react'
import { createElement, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProgressiveDomText } from '../src/client/useProgressiveDomText.ts'

let frames: Map<number, FrameRequestCallback>
let time: number
let next: number
async function paint(count = 1, interval = 16) {
  for (let index = 0; index < count; index++) await act(async () => {
    expect(frames.size).toBeLessThanOrEqual(1)
    const batch = [...frames.values()]
    frames.clear()
    time += interval
    for (const callback of batch) callback(time)
  })
}
function Probe({ settled, pending, speed, paused = false }: {
  paused?: boolean
  settled: () => void
  pending?: (value: boolean) => void
  speed: { current: number }
}) {
  const root = useRef<HTMLDivElement>(null)
  useProgressiveDomText(root, true, true, speed, settled, pending, paused)
  return createElement('div', { ref: root },
    createElement('div', { 'data-chat-call-id': 'a' }, 'a'),
    createElement('div', { 'data-chat-call-id': 'b' }, 'b'.repeat(70)))
}
function setup() {
  const settled = vi.fn()
  const pending = vi.fn()
  const speed = { current: 35 }
  const view = render(createElement(Probe, { settled, pending, speed }))
  const a = view.container.querySelector<HTMLElement>('[data-chat-call-id="a"]')!
  const b = view.container.querySelector<HTMLElement>('[data-chat-call-id="b"]')!
  return { ...view, a, b, aText: a.firstChild as Text, bText: b.firstChild as Text, settled, pending, speed }
}
beforeEach(() => {
  time = 0; next = 0; frames = new Map()
  vi.stubGlobal('performance', { now: () => time })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ordinary DOM playback', () => {
  it('continues through lifecycle signals and caps a minute-long frame gap', async () => {
    const view = setup()
    await paint(5)
    const before = view.b.textContent!.length
    await act(async () => { window.dispatchEvent(new Event('dsha:background')) })
    expect(frames.size).toBe(1)
    await paint(1, 60000)
    const added = view.b.textContent!.length - before
    expect(added).toBeGreaterThan(0)
    expect(added).toBeLessThanOrEqual(4)
    await act(async () => { window.dispatchEvent(new Event('dsha:foreground')) })
    await paint(100)
    expect(view.b.textContent).toBe('b'.repeat(70))
    expect(frames.size).toBe(0)
  })

  it('prioritizes an earlier append and new nodes while hiding later call chrome', async () => {
    const view = setup()
    await paint(5)
    const before = view.b.textContent!
    const c = document.createElement('span')
    c.textContent = 'c'.repeat(30)
    await act(async () => { view.aText.data = 'a'.repeat(30); view.a.parentElement!.append(c) })
    expect(view.b.style.visibility).toBe('hidden')
    await paint(3)
    expect(view.a.textContent!.length).toBeGreaterThan(1)
    expect(view.b.textContent).toBe(before)
    await paint(150)
    expect(view.a.textContent).toBe('a'.repeat(30))
    expect(view.b.textContent).toBe('b'.repeat(70))
    expect(c.textContent).toBe('c'.repeat(30))
    expect(view.settled).toHaveBeenCalledTimes(1)
  })

  it('retains authoritative emoji replacements and truncation', async () => {
    const view = setup()
    await paint(5)
    await act(async () => { view.bText.data = '😀'.repeat(25) })
    await paint(2)
    await act(async () => { view.bText.data = '😀短' })
    await paint(80)
    expect(view.b.textContent).toBe('😀短')
    expect([...view.b.textContent!]).toEqual(['😀', '短'])
    expect(frames.size).toBe(0)
  })

  it('honours only the ordinary relay pause while retaining text progress', async () => {
    const view = setup()
    await paint(5)
    const shown = view.b.textContent
    view.rerender(createElement(Probe, { paused: true, settled: view.settled, pending: view.pending, speed: view.speed }))
    await act(async () => { view.aText.data = 'a'.repeat(30) })
    await paint(5)
    expect(view.b.textContent).toBe(shown)
    expect(view.b.style.visibility).toBe('hidden')
    expect(view.settled).not.toHaveBeenCalled()
    view.rerender(createElement(Probe, { settled: view.settled, pending: view.pending, speed: view.speed }))
    await paint(100)
    expect(view.b.textContent).toBe('b'.repeat(70))
    expect(view.a.textContent).toBe('a'.repeat(30))
    expect(view.settled).toHaveBeenCalledTimes(1)
  })
})
