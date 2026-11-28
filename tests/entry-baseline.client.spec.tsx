import { StrictMode, useMemo, useSyncExternalStore } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createEntryBaseline, getFallbackEntryBaseline, installEntryBaselineSource,
  type EntryBaselineBinding, type EntryBaselineWindow, type EntryBlockSource,
} from '../src/client/entryBaseline.ts'

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { value = next; for (const listener of [...listeners]) listener() },
    listeners,
  }
}
type Entry = EntryBaselineWindow['entries'][number]
function chunk(seq: number, type: string, text = '', index = 0, attemptId = 'attempt-a', blockType = 'text'): Entry {
  return { type: 'transient', event: { type: 'assistant/live-chunk', seq,
    data: { turn: 1, step: 0, attemptId, chunk: { type, text, index, blockType } } } }
}
function source(blockSeq = 1, blockIndex = 0, attemptId = 'attempt-a'): EntryBlockSource {
  return { turn: 1, step: 0, attemptId, blockIndex, blockSeq }
}
const disposers: (() => void)[] = []
function fixture(openState: 'cold' | 'loading' | 'open' | 'error' = 'open', entries: readonly Entry[] = []) {
  const session = observable({ openState })
  const events = observable<EntryBaselineWindow>({ entries, revision: 0, change: { kind: 'replace', entries } })
  let binding: EntryBaselineBinding | undefined = { session, eventSource: events }
  disposers.push(installEntryBaselineSource({ binding: () => binding }))
  const baseline = createEntryBaseline('session-a')
  disposers.push(() => baseline.dispose())
  disposers.push(baseline.subscribe(() => {}))
  return {
    baseline, session, events,
    bind(next: EntryBaselineBinding | undefined) { binding = next },
    publish(kind: EntryBaselineWindow['change']['kind'], added: readonly Entry[] = [], revisionStep = 1) {
      const previous = events.getSnapshot()
      const entries = kind === 'replace' ? added : kind === 'prepend' ? [...added, ...previous.entries]
        : kind === 'append' ? [...previous.entries, ...added] : []
      events.set({ entries, revision: previous.revision + revisionStep, change: { kind, entries: added } })
    },
  }
}

afterEach(() => {
  cleanup()
  for (const dispose of disposers.splice(0).reverse()) dispose()
})

describe('session entry baseline', () => {
  it('shows cached open content immediately, including a running attempt', () => {
    const { baseline } = fixture('open', [chunk(1, 'block-start'), chunk(2, 'text-delta', 'already here')])
    expect(baseline.readBlock(source(), 'already here')).toMatchObject({ initialText: 'already here', animate: false })
    expect(baseline.isLiveSeq(2)).toBe(false)
  })

  it('does not seal an empty cold layout and freezes the first replace before later live deltas', () => {
    const { baseline, session, publish } = fixture('cold')
    expect(baseline.readBlock(source(), '')).toMatchObject({ initialText: '', animate: false })
    session.set({ openState: 'loading' })
    publish('replace', [chunk(1, 'block-start'), chunk(2, 'text-delta', 'old')])
    publish('append', [chunk(3, 'text-delta', '+new')])
    session.set({ openState: 'open' })
    // React may see neither the empty layout nor the intermediate old snapshot.
    expect(baseline.readBlock(source(), 'old+new')).toMatchObject({ initialText: 'old', animate: true })
  })

  it('records appended live suffixes synchronously before a delayed React publication', () => {
    const { baseline, publish } = fixture('open', [chunk(1, 'block-start'), chunk(2, 'text-delta', 'old😀')])
    let rendered = 'old😀'
    function View() {
      useSyncExternalStore(baseline.subscribe, baseline.getSnapshot, baseline.getSnapshot)
      const value = baseline.readBlock(source(), rendered)
      return <output>{value.initialText}|{String(value.animate)}</output>
    }
    const view = render(<View />)
    act(() => {
      publish('append', [chunk(3, 'text-delta', ' live')])
      // An early old-text read must not consume the new provenance marker.
      expect(baseline.readBlock(source(), 'old😀').initialText).toBe('old😀')
      publish('append', [chunk(4, 'text-delta', ' tail')])
      rendered = 'old😀 live tail'
    })
    expect(view.container.textContent).toBe('old😀|true')
    expect(baseline.readBlock(source(), rendered).initialText).toBe('old😀')
  })

  it.each(['text', 'reasoning'])('ingests continuing live %s deltas without publishing unchanged entry baselines', (kind: string) => {
    const delta = `${kind}-delta`
    const { baseline, publish } = fixture('open', [chunk(1, 'block-start', '', 0, 'attempt-a', kind), chunk(2, delta, 'old')])
    const listener = vi.fn()
    disposers.push(baseline.subscribe(listener))
    publish('append', [chunk(3, delta, '+live')])
    expect(listener).toHaveBeenCalledTimes(1)
    const first = baseline.readBlock(source(), 'old+live')
    const revision = baseline.getSnapshot()
    listener.mockClear()

    publish('append', [chunk(4, delta, '+tail'), chunk(5, delta, '😀')])
    expect(listener).not.toHaveBeenCalled()
    expect(baseline.getSnapshot()).toBe(revision)
    expect(baseline.readBlock(source(), 'old+live+tail😀')).toEqual(first)
    expect(baseline.isLiveSeq(5)).toBe(true)

    // Length accounting still sees the quiet packets: a correcting block-end
    // must adopt its authoritative text and notify the presentation subscribers.
    publish('append', [{ type: 'transient', event: { type: 'assistant/live-chunk', seq: 6,
      data: { turn: 1, step: 0, attemptId: 'attempt-a', chunk: { type: 'block-end', index: 0,
        block: { type: kind, text: 'corrected' } } } } }])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(baseline.readBlock(source(), 'corrected').initialText).toBe('corrected')
  })

  it('publishes prepend, settlement, replacement, and binding changes after quiet live packets', () => {
    const { baseline, publish, bind } = fixture()
    const listener = vi.fn()
    disposers.push(baseline.subscribe(listener))
    publish('append', [chunk(1, 'block-start'), chunk(2, 'text-delta', 'live')])
    listener.mockClear()
    publish('append', [chunk(3, 'text-delta', ' tail')])
    expect(listener).not.toHaveBeenCalled()
    publish('prepend', [chunk(-2, 'block-start', '', 0, 'older'), chunk(-1, 'text-delta', 'history', 0, 'older')])
    publish('settle-assistant')
    publish('replace', [chunk(1, 'block-start'), chunk(2, 'text-delta', 'replacement')])
    expect(listener).toHaveBeenCalledTimes(3)
    expect(baseline.readBlock(source(), 'replacement')).toMatchObject({ initialText: 'replacement', animate: false })
    bind(undefined)
    expect(baseline.readBlock(source(), 'unbound').animate).toBe(false)
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('accepts an open empty session as ready without a timer', () => {
    const { baseline, publish } = fixture('open')
    publish('append', [chunk(10, 'block-start'), chunk(11, 'text-delta', 'new')])
    expect(baseline.readBlock(source(10), 'new')).toMatchObject({ initialText: '', animate: true })
  })

  it('keeps prepended history static without swallowing the live tail', () => {
    const { baseline, publish } = fixture('open', [chunk(1, 'block-start'), chunk(2, 'text-delta', 'old')])
    publish('append', [chunk(3, 'text-delta', ' live')])
    const tail = baseline.readBlock(source(), 'old live')
    publish('prepend', [chunk(-2, 'block-start', '', 0, 'older'), chunk(-1, 'text-delta', 'history', 0, 'older')])
    expect(baseline.readBlock(source(-2, 0, 'older'), 'history')).toMatchObject({ initialText: 'history', animate: false })
    expect(baseline.readBlock(source(), 'old live')).toEqual(tail)
    expect(baseline.isLiveSeq(-1)).toBe(false)
    expect(baseline.isLiveSeq(3)).toBe(true)
  })

  it('distinguishes attempts, sparse wire blocks, and restarted wire generations', () => {
    const { baseline, publish } = fixture()
    publish('append', [chunk(1, 'block-start', '', 7), chunk(2, 'text-delta', 'one', 7)])
    const first = baseline.readBlock(source(1, 7), 'one')
    expect(first).toMatchObject({ initialText: '', animate: true })
    expect(baseline.readBlock(source(1, 0), 'one').animate).toBe(false)
    publish('append', [chunk(3, 'block-start', '', 7, 'attempt-b'), chunk(4, 'text-delta', 'two', 7, 'attempt-b')])
    const second = baseline.readBlock(source(3, 7, 'attempt-b'), 'two')
    expect(second.animate).toBe(true)
    expect(second.generation).not.toBe(first.generation)
    publish('append', [chunk(5, 'block-start', '', 7, 'attempt-b'), chunk(6, 'text-delta', 'three', 7, 'attempt-b')])
    expect(baseline.readBlock(source(3, 7, 'attempt-b'), 'three').animate).toBe(false)
    expect(baseline.readBlock(source(5, 7, 'attempt-b'), 'three').generation).not.toBe(second.generation)
  })

  it('keeps same-source regroup reads stable and durable settlement preserves the pending suffix', () => {
    const { baseline, publish } = fixture('open', [chunk(1, 'block-start'), chunk(2, 'text-delta', 'old')])
    publish('append', [chunk(3, 'text-delta', ' pending')])
    const first = baseline.readBlock(source(), 'old pending')
    expect(baseline.readBlock(source(), 'old pending')).toEqual(first)
    publish('settle-assistant')
    expect(baseline.readBlock(source(), 'old pending')).toEqual(first)
    // Durable settlement may contain an authoritative tail not seen in deltas.
    expect(baseline.readBlock(source(), 'old pending final')).toMatchObject({ initialText: 'old', animate: true })
  })

  it('maps sparse retired blocks without rendering live nodes, retaining each historical prefix', () => {
    const { baseline, events, publish } = fixture('open', [
      chunk(1, 'block-start', '', 3, 'attempt-a', 'reasoning'),
      chunk(2, 'reasoning-delta', 'old thought', 3),
      chunk(3, 'block-start', '', 8), chunk(4, 'text-delta', 'old answer', 8),
    ])
    publish('append', [chunk(5, 'reasoning-delta', ' new thought', 3), chunk(6, 'text-delta', ' new answer', 8)])
    const previous = events.getSnapshot()
    const entry: Entry = { type: 'event', event: { type: 'assistant/message', surfaceOp: 'append', seq: 7,
      data: { turn: 1, step: 0, message: { content: [{ type: 'reasoning', text: 'old thought new thought' },
        { type: 'text', text: 'old answer new answer' }] } } } }
    events.set({ entries: [entry], revision: previous.revision + 1,
      change: { kind: 'settle-assistant', attemptId: 'attempt-a', entry } })
    const thought = baseline.settledBlock(1, 0, 7, 0, 'reasoning')!
    const answer = baseline.settledBlock(1, 0, 7, 1, 'text')!
    expect(thought).toEqual(source(1, 3))
    expect(answer).toEqual(source(3, 8))
    expect(baseline.readBlock(thought, 'old thought new thought')).toMatchObject({ initialText: 'old thought', animate: true })
    expect(baseline.readBlock(answer, 'old answer new answer')).toMatchObject({ initialText: 'old answer', animate: true })
    expect(baseline.settledBlock(1, 0, 7, 0, 'text')).toBeUndefined()
    expect(baseline.settledBlock(1, 0, 8, 0, 'reasoning')).toBeUndefined()
    publish('replace', [entry])
    expect(baseline.settledBlock(1, 0, 7, 0, 'reasoning')).toBeUndefined()
  })

  it('invalidates old animation generations on an explicit replacement', () => {
    const { baseline, publish } = fixture()
    publish('append', [chunk(1, 'block-start'), chunk(2, 'text-delta', 'queued')])
    const old = baseline.readBlock(source(), 'queued')
    publish('replace', [chunk(1, 'block-start'), chunk(2, 'text-delta', 'queued')])
    const next = baseline.readBlock(source(), 'queued')
    expect(next).toMatchObject({ initialText: 'queued', animate: false })
    expect(next.generation).not.toBe(old.generation)
    expect(baseline.isLiveSeq(2)).toBe(false)
  })

  it('uses conservative static content for missing binding, unknown mapping and missed source revisions', () => {
    const { baseline, bind, publish } = fixture()
    expect(baseline.readBlock(source(), 'unknown')).toMatchObject({ initialText: 'unknown', animate: false })
    publish('append', [chunk(1, 'block-start'), chunk(2, 'text-delta', 'missed')], 2)
    expect(baseline.readBlock(source(), 'missed').animate).toBe(false)
    bind(undefined)
    expect(baseline.readBlock(source(), 'unbound')).toMatchObject({ initialText: 'unbound', animate: false })
  })

  it('animates directly appended durable assistant messages only with explicit source seq proof', () => {
    const { baseline, publish } = fixture()
    publish('append', [{ type: 'event', event: { type: 'assistant/message', surfaceOp: 'append', seq: 20, data: {} } }])
    const durable = { turn: 1, step: 0, attemptId: undefined, blockIndex: undefined, blockSeq: 20 }
    expect(baseline.readBlock(durable, 'new final')).toMatchObject({ initialText: '', animate: true })
    expect(baseline.readBlock({ ...durable, blockSeq: undefined }, 'unknown').animate).toBe(false)
    expect(baseline.isLiveSeq(20.05)).toBe(false)
  })

  it('reentering a retained session starts a fresh static baseline', () => {
    const { baseline, publish } = fixture()
    publish('append', [chunk(1, 'block-start'), chunk(2, 'text-delta', 'existing')])
    expect(baseline.readBlock(source(), 'existing').animate).toBe(true)
    baseline.dispose()
    const next = createEntryBaseline('session-a')
    disposers.push(() => next.dispose())
    expect(next.readBlock(source(), 'existing')).toMatchObject({ initialText: 'existing', animate: false })
  })

  it('defers fallback source subscriptions until a row is committed and releases them after unmount', async () => {
    const { events, session } = fixture()
    // Remove the fixture observer so this test can count only fallback ownership.
    for (const dispose of disposers.splice(1).reverse()) dispose()
    const fallback = getFallbackEntryBaseline('fallback-session')!
    expect(events.listeners.size).toBe(0)
    expect(session.listeners.size).toBe(0)
    const release = fallback.retain()
    expect(events.listeners.size).toBe(1)
    expect(session.listeners.size).toBe(1)
    release()
    await act(async () => { await Promise.resolve() })
    expect(events.listeners.size).toBe(0)
    expect(session.listeners.size).toBe(0)
  })

  it('owns no subscriptions for abandoned renders and detaches after StrictMode unmount', () => {
    const { events, session } = fixture()
    // Remove the fixture observer so this test can count exactly this component's ownership.
    for (const dispose of disposers.splice(1).reverse()) dispose()
    const abandoned = createEntryBaseline('session-a')
    abandoned.readBlock(source(), 'unknown')
    expect(events.listeners.size).toBe(0)
    expect(session.listeners.size).toBe(0)
    function View() {
      const baseline = useMemo(() => createEntryBaseline('session-a'), [])
      useSyncExternalStore(baseline.subscribe, baseline.getSnapshot, baseline.getSnapshot)
      return null
    }
    const view = render(<StrictMode><View /></StrictMode>)
    expect(events.listeners.size).toBe(1)
    expect(session.listeners.size).toBe(1)
    view.unmount()
    expect(events.listeners.size).toBe(0)
    expect(session.listeners.size).toBe(0)
  })
})
