import { describe, expect, it } from 'vitest'
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
