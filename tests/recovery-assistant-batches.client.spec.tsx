import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSmoothStreamContent } from '../src/client/useSmoothStreamContent.ts'
import { streamRelay } from '../src/client/streamRelay.ts'
import { type BackgroundRecovery } from '../src/settings.ts'

let frames: Map<number, FrameRequestCallback>
let time: number
let next: number
async function paint(count = 1) {
  for (let index = 0; index < count; index++) await act(async () => {
    const batch = [...frames.values()]
    frames.clear()
    time += 16
    for (const callback of batch) callback(time)
  })
}
async function background(hidden: boolean) {
  await act(async () => { window.dispatchEvent(new Event(hidden ? 'dsha:background' : 'dsha:foreground')) })
}
function Probe({ text, mode = 'catch-up', onBatch, onBacklog, enabled = true, hold, recoveryKey, recoveryPosition, inputComplete }: {
  text: string
  mode?: BackgroundRecovery
  onBatch?: (epoch: number | undefined) => void
  onBacklog?: (pending: boolean) => void
  enabled?: boolean
  hold?: () => boolean
  recoveryKey?: string
  recoveryPosition?: readonly [number, number, number]
  inputComplete?: boolean
}) {
  return <output>{useSmoothStreamContent(text, {
    enabled, backgroundRecovery: mode, onRecoveryBatchChange: onBatch,
    onRecoveryBacklogChange: onBacklog, shouldHoldBack: hold,
    ...(recoveryKey === undefined ? {} : { recoveryKey }),
    ...(recoveryPosition === undefined ? {} : { recoveryPosition }),
    ...(inputComplete === undefined ? {} : { inputComplete }),
  })}</output>
}
beforeEach(() => {
  time = 0; next = 0; frames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++next, callback); return next })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('performance', { now: () => time })
})
afterEach(() => { cleanup(); streamRelay.clearAll(); vi.unstubAllGlobals() })

describe('assistant recovery batches', () => {
  it.each(['replay', 'catch-up'] as const)('freezes A, alternates B and C, and keeps a single continuous %s player', async mode => {
    const onBatch = vi.fn()
    const a = 'abc' + '甲'.repeat(37)
    const b = a + '😀'.repeat(60)
    const c = b + '丙'.repeat(40)
    const view = render(<Probe text="abc" mode={mode} onBatch={onBatch} />)
    await paint(30)
    await background(true)
    view.rerender(<Probe text={a} mode={mode} onBatch={onBatch} />)
    await background(false)
    expect(onBatch.mock.calls).toEqual([[0]])
    view.rerender(<Probe text={b} mode={mode} onBatch={onBatch} />)
    await paint()
    let previous = 'abc'
    for (let frame = 0; frame < 100 && view.container.textContent !== a; frame++) {
      await paint()
      const shown = view.container.textContent!
      expect(a.startsWith(shown)).toBe(true)
      expect([...shown].length).toBeGreaterThan([...previous].length)
      expect(frames.size).toBeLessThanOrEqual(1)
      previous = shown
    }
    expect(view.container.textContent).toBe(a)
    expect(onBatch.mock.calls).toEqual([[0], [1]])
    // B was frozen when A ended. Text arriving now must become C, not extend B.
    view.rerender(<Probe text={c} mode={mode} onBatch={onBatch} />)
    previous = a
    for (let frame = 0; frame < 120 && view.container.textContent !== b; frame++) {
      await paint()
      const shown = view.container.textContent!
      expect(b.startsWith(shown)).toBe(true)
      expect([...shown].length).toBeGreaterThan([...previous].length)
      expect(frames.size).toBeLessThanOrEqual(1)
      previous = shown
    }
    expect(view.container.textContent).toBe(b)
    expect(onBatch.mock.calls).toEqual([[0], [1], [2]])
    await paint(100)
    expect(view.container.textContent).toBe(c)
    expect(onBatch.mock.calls).toEqual([[0], [1], [2], [undefined]])
    expect(frames.size).toBe(0)
    const ordinary = c + '新'.repeat(50)
    view.rerender(<Probe text={ordinary} mode={mode} onBatch={onBatch} />)
    await paint(4)
    expect(view.container.textContent!.length).toBeGreaterThan(c.length)
    expect(view.container.textContent!.length).toBeLessThan(ordinary.length)
    expect(onBatch.mock.calls).toHaveLength(4)
  })

  it('assigns foreground text from an idle earlier seat to the receiving batch', async () => {
    const key = JSON.stringify(['idle-seat', '1'])
    const token = streamRelay.acquire({ session: 'idle-seat', turn: '1', step: 1, node: 'later', order: 20, recoveryEpoch: 0 }, 'response')
    const onBatch = vi.fn()
    const view = render(<Probe text="a" onBatch={onBatch} recoveryKey={key} recoveryPosition={[1, 10, 1]} />)
    await paint(20)
    await background(true)
    await background(false)
    await paint(5)
    onBatch.mockClear()
    view.rerender(<Probe text={'a' + '新'.repeat(40)} hold={() => true} onBatch={onBatch} recoveryKey={key} recoveryPosition={[1, 10, 1]} inputComplete />)
    await paint(5)
    expect(onBatch.mock.calls).toEqual([[1]])
    streamRelay.release(token)
  })

  it.each([0, 1, 2])('keeps idle appends behind the current global epoch %s after its old batch settles', async activeEpoch => {
    const key = JSON.stringify(['settled-seat', '1'])
    let token = streamRelay.acquire({ session: 'settled-seat', turn: '1', step: 1, node: 'later', order: 20, recoveryEpoch: 0 }, 'response')
    const onBatch = vi.fn()
    const props = { onBatch, recoveryKey: key, recoveryPosition: [1, 10, 1] as const }
    const view = render(<Probe text="a" {...props} />)
    await paint(20)
    await background(true)
    onBatch.mockClear()
    view.rerender(<Probe text="a旧积压" {...props} />)
    await background(false)
    await paint(20)
    expect(onBatch.mock.calls).toEqual([[0], [undefined]])
    streamRelay.release(token)
    token = streamRelay.acquire({ session: 'settled-seat', turn: '1', step: 1, node: 'later', order: 20, recoveryEpoch: activeEpoch }, 'response')
    view.rerender(<Probe text={'a旧积压' + '新'.repeat(40)} hold={() => true} {...props} />)
    await paint(5)
    expect(onBatch.mock.calls).toEqual([[0], [undefined], [activeEpoch + 1]])
    streamRelay.release(token)
  })

  it('does not let incoming pressure accelerate the frozen replay batch', async () => {
    const a = 'abc' + 'x'.repeat(40)
    const tree = (incoming: string) => <main>
      <Probe text={a} mode="replay" />
      <Probe text={incoming} mode="replay" />
    </main>
    const view = render(tree(a))
    await paint(3)
    await background(true)
    await background(false)
    view.rerender(tree(a + 'y'.repeat(2000)))
    const [control, growing] = [...view.container.querySelectorAll('output')]
    for (let frame = 0; frame < 100 && control!.textContent !== a; frame++) {
      await paint()
      expect(growing!.textContent).toBe(control!.textContent)
    }
    expect(control!.textContent).toBe(a)
    expect(growing!.textContent).toBe(a)
    await paint(5)
    expect(growing!.textContent!.length).toBeGreaterThan(a.length)
  })

  it('keeps the large-backlog latch through A/B handoff instead of announcing a false drain', async () => {
    const onBacklog = vi.fn()
    const onBatch = vi.fn()
    const a = 'abc' + 'x'.repeat(1201)
    const b = a + 'y'.repeat(50)
    const view = render(<Probe text="abc" onBacklog={onBacklog} onBatch={onBatch} />)
    await paint(30)
    await background(true)
    view.rerender(<Probe text={a} onBacklog={onBacklog} onBatch={onBatch} />)
    await background(false)
    view.rerender(<Probe text={b} onBacklog={onBacklog} onBatch={onBatch} />)
    for (let frame = 0; frame < 400 && view.container.textContent !== a; frame++) await paint()
    expect(view.container.textContent).toBe(a)
    expect(onBatch).toHaveBeenLastCalledWith(1)
    expect(onBacklog.mock.calls).toEqual([[true]])
    await paint(30)
    expect(view.container.textContent).toBe(b)
    expect(onBacklog.mock.calls).toEqual([[true], [false]])
  })

  it('supersedes both buffers on a source replacement and never resurrects old suffixes', async () => {
    const onBatch = vi.fn()
    const view = render(<Probe text="abc" onBatch={onBatch} />)
    await paint(30)
    await background(true)
    view.rerender(<Probe text={'abc' + '旧'.repeat(100)} onBatch={onBatch} />)
    await background(false)
    view.rerender(<Probe text={'abc' + '旧'.repeat(100) + '待'.repeat(100)} onBatch={onBatch} />)
    await paint(3)
    view.rerender(<Probe text="替换😀" onBatch={onBatch} />)
    await paint(100)
    expect(view.container.textContent).toBe('替换😀')
    expect(frames.size).toBe(0)
    expect(onBatch).toHaveBeenLastCalledWith(undefined)
  })

  it('refreezes after a second background interval and cancels batches when disabled', async () => {
    const onBatch = vi.fn()
    const a = 'abc' + 'x'.repeat(100)
    const b = a + '😀'.repeat(100)
    const view = render(<Probe text="abc" onBatch={onBatch} />)
    await paint(30)
    await background(true)
    view.rerender(<Probe text={a} onBatch={onBatch} />)
    await background(false)
    view.rerender(<Probe text={b} onBatch={onBatch} />)
    await paint(4)
    const before = view.container.textContent
    await background(true)
    await paint(4)
    expect(view.container.textContent).toBe(before)
    expect(frames.size).toBe(0)
    await background(false)
    await paint(4)
    expect(view.container.textContent!.length).toBeGreaterThan(before!.length)
    view.rerender(<Probe text={b + '!'} onBatch={onBatch} enabled={false} />)
    expect(view.container.textContent).toBe(b + '!')
    expect(frames.size).toBe(0)
    expect(onBatch).toHaveBeenLastCalledWith(undefined)
  })
})
