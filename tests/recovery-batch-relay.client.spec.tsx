import { describe, expect, it, vi } from 'vitest'
import { StreamRelay, type RelayScope } from '../src/client/streamRelay.ts'

const scope = (node: string, order: number): RelayScope => ({
  session: 'ordinary-queue', turn: '1', step: 1, node, order,
})

describe('ordinary relay ordering after lifecycle events', () => {
  it('always prioritizes earlier source input over a later active row', () => {
    const relay = new StreamRelay()
    const earlier = scope('earlier', 10)
    const later = scope('later', 20)
    relay.acquire(later, 'tool')
    const token = relay.acquire(earlier, 'response')
    expect(relay.isBlocked(earlier, 'response')).toBe(false)
    expect(relay.isBlocked(later, 'tool')).toBe(true)
    relay.release(token)
    expect(relay.isBlocked(later, 'tool')).toBe(false)
  })

  it('keeps later steps behind earlier output, independent of mount order', () => {
    const relay = new StreamRelay()
    const first = scope('first', 20)
    const second = { ...scope('second', 10), step: 2 }
    relay.acquire(second, 'tool')
    const token = relay.acquire(first, 'output')
    expect(relay.isBlocked(second, 'tool')).toBe(true)
    expect(relay.isBlocked(first, 'output')).toBe(false)
    relay.release(token)
    expect(relay.isBlocked(second, 'tool')).toBe(false)
  })

  it('notifies ordinary handoff and isolates turns, sessions and tool presence', () => {
    const relay = new StreamRelay()
    const earlier = scope('earlier', 10)
    const later = scope('later', 20)
    const token = relay.acquire(earlier, 'tool')
    const changed = vi.fn()
    relay.subscribeBlocked(later, 'response', changed)
    expect(relay.hasTool(later)).toBe(true)
    expect(relay.isBlocked({ ...later, turn: '2' }, 'response')).toBe(false)
    expect(relay.isBlocked({ ...later, session: 'other' }, 'response')).toBe(false)
    relay.release(token)
    expect(changed).toHaveBeenCalledOnce()
    expect(relay.hasTool(later)).toBe(false)
  })

  it('leaves leases and ordering unchanged by native and browser lifecycle events', () => {
    const relay = new StreamRelay()
    const token = relay.acquire(scope('earlier', 10), 'response')
    for (const event of ['dsha:background', 'dsha:foreground', 'pagehide', 'pageshow']) {
      window.dispatchEvent(new Event(event))
      expect(relay.isBlocked(scope('later', 20), 'tool')).toBe(true)
    }
    relay.release(token)
    expect(relay.isBlocked(scope('later', 20), 'tool')).toBe(false)
  })
})
