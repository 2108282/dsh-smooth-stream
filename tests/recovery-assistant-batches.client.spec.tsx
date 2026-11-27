import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSmoothStreamContent, type UseSmoothStreamContentOptions } from '../src/client/useSmoothStreamContent.ts'

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
function Probe({ text, ...options }: { text: string } & UseSmoothStreamContentOptions) {
  return <output>{useSmoothStreamContent(text, options)}</output>
}
beforeEach(() => {
  time = 0; next = 0; frames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('performance', { now: () => time })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('continuous assistant queue', () => {
  it('accepts appends into one queue without frozen boundaries or surrogate splits', async () => {
    const first = 'abc' + '甲'.repeat(37)
    const second = first + '😀'.repeat(60)
    const final = second + '丙'.repeat(40)
    const view = render(<Probe text="abc" />)
    await paint(30)
    view.rerender(<Probe text={first} />)
    await paint(3)
    view.rerender(<Probe text={second} />)
    await paint(3)
    view.rerender(<Probe text={final} />)
    let previous = view.container.textContent!
    for (let frame = 0; frame < 200 && previous !== final; frame++) {
      await paint()
      const shown = view.container.textContent!
      expect(final.startsWith(shown)).toBe(true)
      expect(shown.startsWith(previous)).toBe(true)
      expect(shown).not.toMatch(/[\uD800-\uDBFF]$/u)
      previous = shown
    }
    expect(view.container.textContent).toBe(final)
    await paint()
    expect(frames.size).toBe(0)
  })

  it('adopts an explicit initial prefix and paces only its suffix', async () => {
    const prefix = 'already displayed😀'
    const text = prefix + '新'.repeat(100)
    const view = render(<Probe text={text} initialDisplayedContent={prefix} />)
    expect(view.container.textContent).toBe(prefix)
    await paint(3)
    expect(view.container.textContent!.startsWith(prefix)).toBe(true)
    expect(view.container.textContent!.length).toBeGreaterThan(prefix.length)
    expect(view.container.textContent!.length).toBeLessThan(text.length)
  })

  it('replaces the source without resurrecting an old queued suffix', async () => {
    const view = render(<Probe text={'abc' + '旧'.repeat(100)} />)
    await paint(5)
    view.rerender(<Probe text={'abc' + '旧'.repeat(100) + '待'.repeat(100)} />)
    await paint(3)
    view.rerender(<Probe text="替换😀" />)
    await paint(100)
    expect(view.container.textContent).toBe('替换😀')
    expect(frames.size).toBe(0)
  })
})
