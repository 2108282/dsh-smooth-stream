import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindRecoverySynchronization } from '../src/client/recoverySynchronization.ts'
import { isBackgroundRecoveryScope, RECOVERY_MAX_CHARS } from '../src/client/backgroundRecovery.ts'
import { useSmoothStreamContent } from '../src/client/useSmoothStreamContent.ts'

const key = '["wire",1]'
let frames: Map<number, FrameRequestCallback>
let time: number
let next: number
const disposers: (() => void)[] = []
async function paint(count = 1) {
  for (let index = 0; index < count; index++) await act(async () => {
    const batch = [...frames.values()]; frames.clear(); time += 16
    for (const callback of batch) callback(time)
  })
}
async function signal(hidden: boolean) {
  await act(async () => window.dispatchEvent(new Event(hidden ? 'dsha:background' : 'dsha:foreground')))
}
function Probe({ text = 'abc', complete = false }: { text?: string; complete?: boolean }) {
  return <output>{useSmoothStreamContent(text, { recoveryKey: key, backgroundRecovery: 'catch-up', inputComplete: complete })}</output>
}
function wire() {
  const generation = createSnapshotStore<{ id: number; host: { home: string } } | undefined>({ id: 1, host: { home: '/tmp' } })
  const state = createSnapshotStore<'connected' | 'connecting' | 'disconnected' | undefined>('connected')
  const session = createSnapshotStore({ openState: 'open' })
  const eventSource = createSnapshotStore({ change: { kind: 'replace' }, revision: 0 })
  const scopeDisposers: (() => void)[] = []
  const binding = { sessionId: 'wire', session, eventSource, ctx: {
    effect: (start: () => () => void) => { const stop = start(); scopeDisposers.push(stop); return stop },
  } }
  const retain = vi.fn()
  const sessions = { binding: vi.fn(() => binding), retain }
  const stop = bindRecoverySynchronization(
    sessions as unknown as Parameters<typeof bindRecoverySynchronization>[0],
    { generation, state } as unknown as Parameters<typeof bindRecoverySynchronization>[1],
  )
  disposers.push(stop)
  return { generation, state, session, eventSource, scopeDisposers, retain,
    baseline: () => eventSource.set({ change: { kind: 'replace' }, revision: eventSource.getSnapshot().revision + 1 }) }
}
beforeEach(() => {
  time = 0; next = 1; frames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = next++; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('performance', { now: () => time })
})
afterEach(() => { cleanup(); for (const stop of disposers.splice(0)) stop(); vi.unstubAllGlobals() })

describe('Session-owned recovery synchronization fence', () => {
  it('waits for an accepted empty baseline rather than connection readiness or an arbitrary quiet timeout', async () => {
    const source = wire()
    render(<Probe />)
    await paint(30)
    await signal(true)
    await act(async () => { source.state.set('connecting'); source.generation.set(undefined) })
    await signal(false)
    await paint(3)
    expect(isBackgroundRecoveryScope(key)).toBe(true)
    await act(async () => { source.generation.set({ id: 2, host: { home: '/tmp' } }); source.state.set('connected') })
    await paint(5)
    expect(isBackgroundRecoveryScope(key)).toBe(true)
    await act(async () => { source.baseline() })
    await paint(2)
    expect(isBackgroundRecoveryScope(key)).toBe(false)
    expect(source.retain).not.toHaveBeenCalled()
  })

  it('preserves delayed resynchronization backlog until its text drains, then stops limiting future foreground input', async () => {
    const source = wire()
    const view = render(<Probe />)
    await paint(30)
    await signal(true)
    await act(async () => { source.generation.set(undefined); source.state.set('connecting') })
    await signal(false)
    await paint(5)
    await act(async () => {
      source.generation.set({ id: 2, host: { home: '/tmp' } }); source.state.set('connected')
      view.rerender(<Probe text={'abc' + 'x'.repeat(1000)} complete />)
      source.baseline()
    })
    const before = view.container.textContent!.length
    await paint(3)
    expect(view.container.textContent!.length - before).toBeGreaterThan(0)
    expect(view.container.textContent!.length - before).toBeLessThanOrEqual(3 * RECOVERY_MAX_CHARS)
    expect(isBackgroundRecoveryScope(key)).toBe(true)
    await paint(300)
    expect(isBackgroundRecoveryScope(key)).toBe(false)
    expect(view.container.textContent!.length).toBe(1003)
  })

  it('accepts a baseline published between generation readiness and the connected-state notification', async () => {
    const source = wire()
    render(<Probe />)
    await paint(30)
    await signal(true)
    await act(async () => { source.generation.set(undefined); source.state.set('connecting') })
    await signal(false)
    await act(async () => {
      source.generation.set({ id: 2, host: { home: '/tmp' } })
      source.baseline()
      source.state.set('connected')
    })
    await paint(2)
    expect(isBackgroundRecoveryScope(key)).toBe(false)
  })

  it('keeps the catch-up clock running when a normal Session snapshot is published before every frame', async () => {
    const source = wire()
    const view = render(<Probe />)
    await paint(30)
    await signal(true)
    view.rerender(<Probe text={'abc' + 'x'.repeat(1000)} />)
    await signal(false)
    await paint(1)
    for (let index = 0; index < 10; index++) {
      const before = view.container.textContent!.length
      await act(async () => { source.session.set({ openState: 'open' }) })
      await paint(1)
      const added = view.container.textContent!.length - before
      expect(added).toBeGreaterThan(0)
      expect(added).toBeLessThanOrEqual(RECOVERY_MAX_CHARS)
    }
    expect(isBackgroundRecoveryScope(key)).toBe(true)
  })

  it('retires a terminal synchronization error instead of keeping an empty recovery scope forever', async () => {
    const source = wire()
    render(<Probe />)
    await paint(30)
    await signal(true)
    await act(async () => { source.generation.set(undefined); source.state.set('connecting') })
    await signal(false)
    await paint(3)
    expect(isBackgroundRecoveryScope(key)).toBe(true)
    await act(async () => { source.session.set({ openState: 'error' }) })
    await paint(2)
    expect(isBackgroundRecoveryScope(key)).toBe(false)
  })
})
