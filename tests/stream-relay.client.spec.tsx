import { describe, expect, it, vi } from 'vitest'
import { relayScope, StreamRelay, type RelayScope } from '../src/client/streamRelay.ts'

const scope: RelayScope = { session: 'a', turn: '1', step: 1, node: 'assistant:1', order: 1 }

describe('scoped stream relay leases', () => {
  it('isolates sessions, turns and future steps', () => {
    const relay = new StreamRelay()
    const token = relay.acquire(scope, 'reasoning')
    expect(relay.isBlocked(scope, 'response')).toBe(true)
    expect(relay.isBlocked({ ...scope, session: 'b' }, 'response')).toBe(false)
    expect(relay.isBlocked({ ...scope, turn: '2' }, 'tool')).toBe(false)
    expect(relay.isBlocked({ ...scope, step: 0 }, 'tool')).toBe(false)
    expect(relay.isBlocked({ ...scope, step: 2 }, 'reasoning')).toBe(true)
    relay.release(token)
    expect(relay.isBlocked(scope, 'response')).toBe(false)
  })

  it('does not allow one instance to overwrite another active lease', () => {
    const relay = new StreamRelay()
    const a = relay.acquire(scope, 'response')
    const b = relay.acquire(scope, 'response')
    relay.update(a, false)
    expect(relay.isBlocked(scope, 'tool')).toBe(true)
    relay.release(a)
    expect(relay.isBlocked(scope, 'tool')).toBe(true)
    relay.release(b)
    expect(relay.isBlocked(scope, 'tool')).toBe(false)
    relay.update(a, true)
    expect(relay.isBlocked(scope, 'tool')).toBe(false)
  })

  it('orders parts of one node and nodes in one step without self-blocking', () => {
    const relay = new StreamRelay()
    const a = relay.acquire(scope, 'reasoning')
    const b = relay.acquire(scope, 'response')
    expect(relay.isBlocked(scope, 'reasoning')).toBe(false)
    expect(relay.isBlocked(scope, 'response')).toBe(true)
    expect(relay.isBlocked({ ...scope, node: 'tool:1', order: 2 }, 'tool')).toBe(true)
    expect(relay.isBlocked({ ...scope, node: 'earlier', order: 0 }, 'tool')).toBe(false)
    relay.release(a)
    expect(relay.isBlocked(scope, 'response')).toBe(false)
    expect(relay.isBlocked(scope, 'tool')).toBe(true)
    relay.release(b)
    expect(relay.isBlocked(scope, 'tool')).toBe(false)
  })

  it('uses source event order instead of part category order across nodes', () => {
    const relay = new StreamRelay()
    const laterReasoning = relay.acquire({ ...scope, node: 'later', order: 4, sourceOrder: 40 }, 'reasoning')
    const earlierTool = relay.acquire({ ...scope, node: 'earlier', order: 4, sourceOrder: 20 }, 'tool')
    expect(relay.isBlocked({ ...scope, node: 'later', order: 4, sourceOrder: 40 }, 'reasoning')).toBe(true)
    relay.release(earlierTool)
    expect(relay.isBlocked({ ...scope, node: 'later', order: 4, sourceOrder: 40 }, 'reasoning')).toBe(false)
    relay.release(laterReasoning)
  })

  it('does not turn a missing anchor into the earliest position', () => {
    const relay = new StreamRelay()
    const unknown = relay.acquire({ ...scope, node: 'unknown', order: Number.NaN }, 'output')
    relay.acquire({ ...scope, node: 'known', order: 2 }, 'response')
    expect(relay.isBlocked({ ...scope, node: 'unknown', order: Number.NaN }, 'output')).toBe(false)
    relay.release(unknown)
  })
  it('uses tool presence without a tool ever blocking its preceding text', () => {
    const relay = new StreamRelay()
    const tool = relay.acquire({ ...scope, node: 'tool:1', order: 2 }, 'tool', false)
    expect(relay.hasTool(scope)).toBe(true)
    expect(relay.hasTool({ ...scope, session: 'b' })).toBe(false)
    expect(relay.hasTool({ ...scope, step: 2 })).toBe(false)
    expect(relay.isBlocked(scope, 'response')).toBe(false)
    relay.release(tool)
    expect(relay.hasTool(scope)).toBe(false)
  })


  it('notifies only same-turn blocked queries whose result changes', () => {
    const relay = new StreamRelay()
    const preceding = vi.fn()
    const after = vi.fn()
    const otherSession = vi.fn()
    const otherTurn = vi.fn()
    const legacy = vi.fn()
    relay.subscribeBlocked(scope, 'reasoning', preceding)
    const stop = relay.subscribeBlocked(scope, 'response', after)
    relay.subscribeBlocked({ ...scope, session: 'b' }, 'response', otherSession)
    relay.subscribeBlocked({ ...scope, turn: '2' }, 'response', otherTurn)
    relay.subscribe(legacy)

    const idle = relay.acquire(scope, 'reasoning', false)
    expect(after).not.toHaveBeenCalled()
    relay.update(idle, true)
    const duplicate = relay.acquire(scope, 'reasoning')
    relay.update(idle, false)
    relay.release(idle)
    expect(after).toHaveBeenCalledTimes(1)
    expect(relay.isBlocked(scope, 'response')).toBe(true)
    relay.release(duplicate)
    expect(after).toHaveBeenCalledTimes(2)
    expect(relay.isBlocked(scope, 'response')).toBe(false)
    stop()
    relay.acquire(scope, 'reasoning')
    expect(after).toHaveBeenCalledTimes(2)
    expect(preceding).not.toHaveBeenCalled()
    expect(otherSession).not.toHaveBeenCalled()
    expect(otherTurn).not.toHaveBeenCalled()
    expect(legacy).not.toHaveBeenCalled()
    relay.setTextActive('legacy', true)
    expect(legacy).toHaveBeenCalledOnce()
    expect(preceding).not.toHaveBeenCalled()
  })

  it('keeps tool presence counted per step independently of active leases', () => {
    const relay = new StreamRelay()
    const sameStep = vi.fn()
    const nextStep = vi.fn()
    const otherTurn = vi.fn()
    const otherSession = vi.fn()
    const stop = relay.subscribeTool(scope, sameStep)
    relay.subscribeTool({ ...scope, step: 2 }, nextStep)
    relay.subscribeTool({ ...scope, turn: '2' }, otherTurn)
    relay.subscribeTool({ ...scope, session: 'b' }, otherSession)
    const first = relay.acquire({ ...scope, node: 'tool:1', order: 2 }, 'tool', false)
    const second = relay.acquire({ ...scope, node: 'tool:2', order: 3 }, 'tool')
    relay.update(second, false)
    relay.update(first, true)
    relay.release(first)
    expect(relay.hasTool(scope)).toBe(true)
    expect(sameStep).toHaveBeenCalledOnce()
    relay.release(second)
    expect(relay.hasTool(scope)).toBe(false)
    expect(sameStep).toHaveBeenCalledTimes(2)
    expect(nextStep).not.toHaveBeenCalled()
    expect(otherTurn).not.toHaveBeenCalled()
    expect(otherSession).not.toHaveBeenCalled()
    stop()
    relay.acquire(scope, 'tool', false)
    expect(sameStep).toHaveBeenCalledTimes(2)
  })

  it('keeps same-node part ordering even when two viewport snapshots report different orders', () => {
    const relay = new StreamRelay()
    const ownLaterPart = relay.acquire({ ...scope, order: 0 }, 'response')
    const foreignLaterPart = relay.acquire({ ...scope, node: 'foreign', order: 4 }, 'response')
    const ownEarlierPart = relay.acquire({ ...scope, order: 10 }, 'reasoning')
    expect(relay.isBlocked(scope, 'reasoning')).toBe(false)
    expect(relay.isBlocked(scope, 'response')).toBe(true)
    relay.update(ownEarlierPart, false)
    expect(relay.isBlocked(scope, 'response')).toBe(false)
    expect(relay.isBlocked({ ...scope, order: 5 }, 'response')).toBe(true)
    expect(relay.isBlocked({ ...scope, order: 4 }, 'response')).toBe(false)
    expect(relay.isBlocked({ ...scope, order: 4 }, 'tool')).toBe(true)
    relay.release(foreignLaterPart)
    expect(relay.isBlocked({ ...scope, order: 5 }, 'response')).toBe(false)
    relay.release(ownLaterPart)
  })

  it('queries the active index without iterating idle leases or evaluating unrelated turns', () => {
    const relay = new StreamRelay()
    for (let i = 0; i < 1000; i++) {
      relay.acquire({ ...scope, node: `idle:${i}`, order: 0 }, 'reasoning', false)
    }
    const foreign = { ...scope, turn: '2' }
    const other = relay.acquire(foreign, 'reasoning')
    const own = relay.acquire(scope, 'reasoning')
    // Enforce the cost contract directly, independent of clock resolution and device load.
    const indexes = relay as unknown as {
      leases: Map<symbol, unknown>
      activeTurns: Map<string, Map<number | undefined, { blocks: (scope: RelayScope, part: string) => boolean }>>
    }
    const scans = [vi.spyOn(indexes.leases, 'values'), vi.spyOn(indexes.leases, 'entries'),
      vi.spyOn(indexes.leases, 'forEach'), vi.spyOn(indexes.leases, Symbol.iterator)]
    const otherQuery = vi.spyOn(indexes.activeTurns.get(JSON.stringify([foreign.session, foreign.turn]))!.get(undefined)!, 'blocks')
    const otherListener = vi.fn()
    relay.subscribeBlocked(foreign, 'response', otherListener)
    otherQuery.mockClear()
    expect(relay.isBlocked(scope, 'response')).toBe(true)
    relay.update(own, false)
    expect(relay.isBlocked(scope, 'response')).toBe(false)
    expect(indexes.activeTurns.size).toBe(1)
    relay.release(own)
    expect(otherQuery).not.toHaveBeenCalled()
    expect(otherListener).not.toHaveBeenCalled()
    expect(relay.hasTool(scope)).toBe(false)
    expect(scans.every(scan => scan.mock.calls.length === 0)).toBe(true)
    relay.release(other)
    expect(indexes.activeTurns.size).toBe(0)
    expect(otherListener).toHaveBeenCalledOnce()
  })

  it('clears state while preserving scoped subscriptions and ignores retired tokens', () => {
    const relay = new StreamRelay()
    const first = relay.acquire(scope, 'reasoning')
    const tool = relay.acquire(scope, 'tool', false)
    const blocked = vi.fn(() => relay.isBlocked(scope, 'response'))
    const hasTool = vi.fn(() => relay.hasTool(scope))
    const legacy = vi.fn()
    relay.subscribeBlocked(scope, 'response', blocked)
    relay.subscribeTool(scope, hasTool)
    relay.subscribe(legacy)
    relay.clearAll()
    relay.clearAll()
    relay.update(first, true)
    relay.release(tool)
    expect(blocked.mock.results.map(result => result.value)).toEqual([false])
    expect(hasTool.mock.results.map(result => result.value)).toEqual([false])
    expect(legacy).not.toHaveBeenCalled()
    relay.acquire(scope, 'reasoning')
    relay.acquire(scope, 'tool', false)
    relay.setReasoningActive('legacy', true)
    relay.clearAll()
    expect(blocked.mock.results.map(result => result.value)).toEqual([false, true, false])
    expect(hasTool.mock.results.map(result => result.value)).toEqual([false, true, false])
    expect(legacy).toHaveBeenCalledTimes(2)
  })

  it('rechecks the current result after a reentrant clear and honors unsubscribe during dispatch', () => {
    const relay = new StreamRelay()
    const observed: boolean[] = []
    const later = vi.fn()
    const removed = vi.fn()
    let stopRemoved = () => {}
    relay.subscribeBlocked(scope, 'response', () => {
      const blocked = relay.isBlocked(scope, 'response')
      observed.push(blocked)
      if (blocked) {
        stopRemoved()
        relay.clearAll()
      }
    })
    stopRemoved = relay.subscribeBlocked(scope, 'response', removed)
    relay.subscribeBlocked(scope, 'response', later)
    relay.acquire(scope, 'reasoning')
    expect(observed).toEqual([true, false])
    expect(removed).not.toHaveBeenCalled()
    expect(later).not.toHaveBeenCalled()
  })

  it('keeps explicit legacy turn queries isolated', () => {
    const relay = new StreamRelay()
    relay.setReasoningActive('a', true)
    expect(relay.isToolBlocked('a')).toBe(true)
    expect(relay.isToolBlocked('b')).toBe(false)
    relay.resetTurn('a')
    expect(relay.isToolBlocked('a')).toBe(false)
  })

  it('reads session/turn/step/node identity from current owner data and location', () => {
    expect(relayScope({ key: 'tool:3', anchorSeq: 4, location: {
      kind: 'step', turn: { turn: 2 }, step: { step: 3 },
    } }, 'session')).toEqual({ session: 'session', turn: '2', step: 3, node: 'tool:3', order: 4 })
  })
})
