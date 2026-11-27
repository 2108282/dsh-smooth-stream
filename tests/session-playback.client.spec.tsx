import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPlayback, type PlaybackSegment } from '../src/client/sessionPlayback.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'

type Frame = (time: number) => void

let time: number
let nextFrame: number
let frames: Map<number, Frame>
const engines: SessionPlayback[] = []

function createPlayback(charsPerSecond = 1000, maxLagChars?: number): SessionPlayback {
  const playback = new SessionPlayback({
    requestFrame: callback => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    },
    cancelFrame: id => { frames.delete(id) },
    now: () => time,
    charsPerSecond,
    // These legacy queue fixtures opt out of production tuning caps; individual
    // tuning regressions below install explicit runtime limits instead.
    tuning: { queuePressure: 0, maxRevealCps: Math.max(1000, charsPerSecond), cadenceClamp: 1_000_000 },
    ...(maxLagChars === undefined ? {} : { maxLagChars }),
  })
  engines.push(playback)
  return playback
}

function segment(
  id: string,
  order: readonly number[],
  text: string,
  sealed = true,
  hidden = false,
): PlaybackSegment {
  return { id, order, text, sealed, hidden }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function paint(milliseconds = 1): void {
  time += milliseconds
  const next = frames.entries().next().value as [number, Frame] | undefined
  if (!next) throw new Error('expected a scheduled animation frame')
  frames.delete(next[0])
  next[1](time)
}

beforeEach(() => {
  time = 0
  nextFrame = 1
  frames = new Map()
})

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
  frames.clear()
  vi.restoreAllMocks()
})

describe('SessionPlayback', () => {
  it('batches owner registration and serializes by lexicographic order on one clock', async () => {
    const playback = createPlayback()
    playback.upsert('later', [segment('later', [2], 'later')], true)
    playback.upsert('earlier', [segment('early', [1, 4], 'early')], true)
    playback.sealInitial()
    expect(frames.size).toBe(0)
    await settle()
    expect(frames.size).toBe(1)

    paint(2)
    await settle()
    expect(playback.read('early').text).toBe('ea')
    expect(playback.read('later')).toMatchObject({ text: '', entered: false, pending: true })
    expect(frames.size).toBe(1)
    paint(1)
    await settle()
    expect(playback.read('early').text).toBe('ear')
    paint(1)
    await settle()
    expect(playback.read('early').text).toBe('earl')
    paint(1)
    await settle()
    expect(playback.read('early').text).toBe('early')
    expect(playback.read('later')).toMatchObject({ text: '', entered: true, pending: true })
    paint(2)
    await settle()
    expect(playback.read('later').text).toBe('la')
  })

  it('stops at a silent unsealed head and resumes on append and block-end seal', async () => {
    const playback = createPlayback()
    playback.upsert('stream', [segment('open', [1], 'a', false)], true)
    playback.upsert('next', [segment('next', [2], 'b')], true)
    await settle()
    paint()
    await settle()
    expect(playback.read('open')).toMatchObject({ text: 'a', entered: true, pending: true })
    expect(frames.size).toBe(0)
    expect(playback.read('next').entered).toBe(false)

    playback.upsert('stream', [segment('open', [1], 'ab', false)], true)
    await settle()
    expect(frames.size).toBe(1)
    paint()
    await settle()
    expect(playback.read('open').text).toBe('ab')
    expect(frames.size).toBe(0)

    playback.upsert('stream', [segment('open', [1], 'ab', true)], true)
    await settle()
    expect(playback.read('open').pending).toBe(false)
    expect(frames.size).toBe(1)
    paint()
    await settle()
    expect(playback.read('next').text).toBe('b')
  })

  it('enters empty sealed cards atomically and only when they reach the head', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [
      segment('card', [1], '', true),
      segment('body', [2], 'x'),
    ], true)
    await settle()
    expect(playback.read('card')).toMatchObject({ text: '', entered: true, pending: false })
    expect(playback.read('body')).toMatchObject({ text: '', entered: false, pending: true })
    expect(frames.size).toBe(1)
    paint()
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 'x', entered: true, pending: false })
  })

  it('fast-forwards hidden content but keeps an unsealed hidden segment as a protocol barrier', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [
      segment('hidden', [1], 'hidden text', false, true),
      segment('visible', [2], 'after'),
    ], true)
    await settle()
    expect(playback.read('hidden')).toMatchObject({ text: 'hidden text', entered: true, pending: true })
    expect(playback.read('visible')).toMatchObject({ text: '', entered: false, pending: true })
    expect(frames.size).toBe(0)

    playback.upsert('owner', [
      segment('hidden', [1], 'hidden text', true, true),
      segment('visible', [2], 'after'),
    ], true)
    await settle()
    paint(2)
    await settle()
    expect(playback.read('visible').text).toBe('af')
  })

  it('does not enter a hidden later segment before an earlier source seals', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [segment('open', [1], 'a', false)], true)
    playback.upsert('owner-hidden', [segment('hidden', [2], 'reasoning', true, true)], true)
    await settle()
    expect(playback.read('hidden')).toMatchObject({ text: '', entered: false, pending: true })

    paint()
    await settle()
    expect(playback.read('open')).toMatchObject({ text: 'a', entered: true, pending: true })
    expect(playback.read('hidden')).toMatchObject({ text: '', entered: false, pending: true })

    playback.upsert('owner', [segment('open', [1], 'a', true)], true)
    await settle()
    expect(playback.read('hidden')).toMatchObject({ text: 'reasoning', entered: true, pending: false })
  })

  it('reveals Unicode code points without splitting surrogate pairs', async () => {
    const playback = createPlayback(1000)
    playback.upsert('owner', [segment('unicode', [1], '😀x')], true)
    await settle()
    paint(1)
    await settle()
    expect(playback.read('unicode').text).toBe('😀')
    paint(1)
    await settle()
    expect(playback.read('unicode').text).toBe('😀x')
  })

  it('shows static history immediately while later live segments start from empty', async () => {
    const playback = createPlayback()
    playback.upsert('history', [segment('old', [1], 'old')], false)
    playback.upsert('live', [segment('new', [2], 'new')], true)
    await settle()
    expect(playback.read('old')).toMatchObject({ text: 'old', entered: true, pending: false })
    expect(playback.read('new')).toMatchObject({ text: '', entered: false, pending: true })
    paint(2)
    await settle()
    expect(playback.read('new').text).toBe('ne')
  })

  it('preserves prefix progress, resets a non-prefix current source, and honors an explicit retry', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [segment('token', [1], 'abcd', false)], true)
    await settle()
    paint(2)
    await settle()
    expect(playback.read('token').text).toBe('ab')

    playback.upsert('owner', [segment('token', [1], 'abcdef', false)], true)
    await settle()
    expect(playback.read('token').text).toBe('ab')
    paint(1)
    await settle()
    expect(playback.read('token').text).toBe('abc')

    playback.upsert('owner', [segment('token', [1], 'replacement', false)], true)
    await settle()
    expect(playback.read('token').text).toBe('')
    paint(1)
    await settle()
    expect(playback.read('token').text).toBe('r')

    playback.upsert('owner', [segment('token', [1], 'replacement', true)], true)
    await settle()
    paint(20)
    await settle()
    expect(playback.read('token').pending).toBe(false)
    playback.upsert('owner', [segment('token', [1], 'retry', false)], true)
    await settle()
    expect(playback.read('token')).toMatchObject({ text: '', entered: false, pending: true })
  })

  it('retains bounded owner-removal ledger state so a strict remount does not replay history', async () => {
    const playback = createPlayback()
    playback.upsert('first mount', [segment('history', [1], 'done')], false)
    await settle()
    playback.remove('first mount')
    await settle()
    expect(playback.read('history')).toMatchObject({ text: '', entered: false, pending: false })

    playback.upsert('strict remount', [segment('history', [1], 'done')], true)
    playback.upsert('live', [segment('live', [2], 'next')], true)
    await settle()
    expect(playback.read('history')).toMatchObject({ text: 'done', entered: true, pending: false })
    expect(playback.read('live')).toMatchObject({ text: '', entered: false, pending: true })
    paint(1)
    await settle()
    expect(playback.read('live').text).toBe('n')
  })

  it('publishes only display changes and exposes methods safe for direct subscription use', async () => {
    const playback = createPlayback()
    const listener = vi.fn()
    const subscribe = playback.subscribe
    const getRevision = playback.getRevision
    const stop = subscribe(listener)
    playback.upsert('owner', [segment('id', [1], 'a', false)], true)
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
    const revision = getRevision()
    playback.upsert('owner', [segment('id', [1], 'a', false)], true)
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getRevision()).toBe(revision)

    stop()
    paint()
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('caps catch-up bursts at 256 code points even when configured lower', async () => {
    const playback = createPlayback(1_000_000, 3)
    playback.upsert('owner', [segment('long', [1], 'x'.repeat(600))], true)
    await settle()
    paint(1)
    await settle()
    expect(playback.read('long').text).toHaveLength(256)
    paint(1)
    await settle()
    expect(playback.read('long').text).toHaveLength(512)
  })

  it('cancels its sole frame on repeated dispose and fast-forwards without crossing an open seal', async () => {
    const cancel = vi.fn((id: number) => { frames.delete(id) })
    const playback = new SessionPlayback({
      requestFrame: callback => {
        const id = nextFrame++
        frames.set(id, callback)
        return id
      },
      cancelFrame: cancel,
      now: () => time,
      charsPerSecond: 1000,
    })
    engines.push(playback)
    playback.upsert('owner', [
      segment('open', [1], 'open', false),
      segment('later', [2], 'later'),
    ], true)
    await settle()
    playback.fastForward()
    await settle()
    expect(playback.read('open')).toMatchObject({ text: 'open', entered: true, pending: true })
    expect(playback.read('later')).toMatchObject({ text: '', entered: false, pending: true })
    playback.setEnabled(false)
    await settle()
    expect(frames.size).toBe(0)
    playback.dispose()
    playback.dispose()
    expect(frames.size).toBe(0)
  })

  it('resets an unsealed same-prefix source when its explicit generation changes', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [{ ...segment('retry', [1], 'abcdef', false), generation: 1 }], true)
    await settle()
    paint(2)
    await settle()
    expect(playback.read('retry').text).toBe('ab')

    playback.upsert('owner', [{ ...segment('retry', [1], 'abcdefg', false), generation: 1 }], true)
    await settle()
    expect(playback.read('retry').text).toBe('ab')
    playback.upsert('owner', [{ ...segment('retry', [1], 'abcdefg', false), generation: 2 }], true)
    await settle()
    expect(playback.read('retry')).toMatchObject({ text: '', entered: false, pending: true })
    paint(1)
    await settle()
    expect(playback.read('retry').text).toBe('a')
  })

  it('pauses incoming targets and resumes without debt from the time spent suspended', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [segment('body', [1], 'abcdef', false)], true)
    await settle()
    paint(2)
    await settle()
    playback.pause()
    playback.pause()
    expect(frames.size).toBe(0)
    time += 60_000
    playback.upsert('owner', [segment('body', [1], 'abcdefgh', false)], true)
    playback.upsert('later', [segment('hidden', [2], 'hidden', true, true), segment('card', [3], '')], true)
    await settle()
    expect(playback.read('body').text).toBe('ab')
    expect(playback.read('hidden').entered).toBe(false)
    expect(playback.read('card').entered).toBe(false)
    expect(frames.size).toBe(0)
    playback.resume()
    playback.resume()
    await settle()
    expect(frames.size).toBe(1)
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('abc')
  })

  it('does not enter cards or static targets from a queued pump while paused', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [segment('card', [2], '')], true)
    playback.pause()
    playback.upsert('history', [segment('old', [1], 'history')], false)
    playback.setEnabled(false)
    await settle()
    expect(playback.read('card').entered).toBe(false)
    expect(playback.read('old').text).toBe('')
    expect(frames.size).toBe(0)
    playback.resume()
    await settle()
    expect(playback.read('old').text).toBe('history')
    expect(playback.read('card').entered).toBe(true)
  })

  it('replays recovery at the ordinary configured speed', async () => {
    const playback = createPlayback(100)
    playback.pause()
    playback.upsert('owner', [segment('body', [1], 'x'.repeat(40), false)], true)
    playback.beginRecovery('replay')
    playback.resume()
    await settle()
    paint(100)
    await settle()
    expect(playback.read('body').text).toHaveLength(10)
    paint(100)
    await settle()
    expect(playback.read('body').text).toHaveLength(20)
  })

  it('caps catch-up at sixteen Unicode code points shared across owners each frame', async () => {
    const playback = createPlayback(10)
    playback.upsert('first', [segment('first', [1], '😀'.repeat(10))], true)
    playback.upsert('second', [segment('second', [2], '中'.repeat(30), false)], true)
    playback.setRecovery('catch-up')
    await settle()
    paint(10_000)
    await settle()
    expect(Array.from(playback.read('first').text)).toHaveLength(10)
    expect(Array.from(playback.read('second').text)).toHaveLength(6)
    paint(80)
    await settle()
    expect(Array.from(playback.read('second').text)).toHaveLength(22)
  })

  it('freezes the catch-up frontier so appended live text returns to normal cadence', async () => {
    const playback = createPlayback(10)
    playback.upsert('owner', [segment('body', [1], 'x'.repeat(40), false)], true)
    playback.beginRecovery('catch-up')
    playback.upsert('owner', [segment('body', [1], 'x'.repeat(40) + 'y'.repeat(20), false)], true)
    await settle()
    for (let index = 0; index < 3; index++) {
      paint(80)
      await settle()
    }
    expect(playback.read('body').text).toBe('x'.repeat(40))
    paint(100)
    await settle()
    expect(playback.read('body').text).toBe('x'.repeat(40) + 'y')
    playback.upsert('new', [segment('new', [2], 'new')], true)
    await settle()
    expect(playback.read('new').entered).toBe(false)
  })

  it('retains an explicit unsealed barrier throughout catch-up', async () => {
    const playback = createPlayback(10)
    playback.upsert('first', [segment('first', [1], 'ab', false)], true)
    playback.upsert('second', [segment('second', [2], 'x'.repeat(20))], true)
    playback.beginRecovery('catch-up')
    await settle()
    paint(80)
    await settle()
    expect(playback.read('first')).toMatchObject({ text: 'ab', pending: true })
    expect(playback.read('second').entered).toBe(false)
    expect(frames.size).toBe(0)
    playback.upsert('first', [segment('first', [1], 'ab', true)], true)
    await settle()
    paint(80)
    await settle()
    expect(playback.read('second').text).toHaveLength(16)
  })

  it('latest skips only frozen targets and never crosses an unsealed predecessor', async () => {
    const playback = createPlayback(10)
    playback.pause()
    playback.upsert('first', [segment('first', [1], 'abc', false)], true)
    playback.upsert('second', [segment('second', [2], 'tail')], true)
    playback.beginRecovery('latest')
    playback.upsert('first', [segment('first', [1], 'abcd', false)], true)
    playback.upsert('second', [segment('second', [2], 'tailmore')], true)
    await settle()
    expect(playback.read('first').text).toBe('')
    playback.resume()
    await settle()
    expect(playback.read('first').text).toBe('abc')
    expect(playback.read('second').entered).toBe(false)
    paint(100)
    await settle()
    expect(playback.read('first').text).toBe('abcd')
    expect(frames.size).toBe(0)
    playback.upsert('first', [segment('first', [1], 'abcd', true)], true)
    await settle()
    expect(playback.read('second').text).toBe('tail')
    paint(100)
    await settle()
    expect(playback.read('second').text).toBe('tailm')
  })

  it('does not apply an obsolete recovery frontier to a replacement generation', async () => {
    const playback = createPlayback(10)
    playback.upsert('owner', [{ ...segment('body', [1], 'x'.repeat(40), false), generation: 'old' }], true)
    playback.beginRecovery('catch-up')
    playback.upsert('owner', [{ ...segment('body', [1], 'x'.repeat(40), false), generation: 'new' }], true)
    await settle()
    paint(100)
    await settle()
    expect(playback.read('body').text).toHaveLength(1)
  })

  it('updates base speed, reveal scale, speed ceiling, and cadence cap without resetting progress', async () => {
    const playback = createPlayback(100)
    playback.upsert('owner', [segment('body', [1], 'x'.repeat(100), false)], true)
    await settle()
    paint(10)
    await settle()
    expect(playback.read('body').text).toHaveLength(1)
    playback.configure({ charsPerSecond: 100, tuning: { revealScale: 2, maxRevealCps: 1000, cadenceClamp: 100 } })
    await settle()
    paint(10)
    await settle()
    expect(playback.read('body').text).toHaveLength(3)
    playback.configure({ tuning: { maxRevealCps: 150 } })
    await settle()
    paint(20)
    await settle()
    expect(playback.read('body').text).toHaveLength(6)
    playback.configure({ tuning: { maxRevealCps: 1000, cadenceClamp: 2 } })
    await settle()
    paint(100)
    await settle()
    expect(playback.read('body').text).toHaveLength(8)
    playback.configure({ charsPerSecond: 50, tuning: { revealScale: 1, cadenceClamp: 100 } })
    await settle()
    paint(20)
    await settle()
    expect(playback.read('body').text).toHaveLength(9)
  })

  it('honors production tuning defaults instead of an uncapped constructor speed', async () => {
    const playback = createPlayback(1000)
    playback.configure({ tuning: DEFAULT_STREAM_DEBUG_TUNING })
    playback.upsert('owner', [segment('body', [1], 'x'.repeat(100), false)], true)
    await settle()
    paint(100)
    await settle()
    expect(playback.read('body').text).toHaveLength(DEFAULT_STREAM_DEBUG_TUNING.cadenceClamp)
  })

  it('ignores unchanged or invalid configuration without repeatedly resetting the frame clock', async () => {
    const playback = createPlayback(100)
    playback.upsert('owner', [segment('body', [1], 'abcd', false)], true)
    await settle()
    time += 5
    playback.configure({ charsPerSecond: 100, tuning: { revealScale: 1, queuePressure: 0 } })
    playback.configure({ charsPerSecond: Number.NaN, tuning: { revealScale: -1, maxRevealCps: Number.POSITIVE_INFINITY } })
    paint(5)
    await settle()
    expect(playback.read('body').text).toBe('a')
  })

  it('holds pending after the final visible character until its delay ends on the sole frame clock', async () => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('owner', [segment('first', [1], 'a'), segment('card', [2], ''), segment('next', [3], 'b')], true)
    await settle()
    paint(1)
    await settle()
    expect(playback.read('first')).toMatchObject({ text: 'a', pending: true })
    expect(playback.read('card').entered).toBe(false)
    expect(playback.read('next').entered).toBe(false)
    expect(frames.size).toBe(1)
    paint(239)
    await settle()
    expect(playback.read('first').pending).toBe(true)
    expect(playback.read('card').entered).toBe(false)
    paint(1)
    await settle()
    expect(playback.read('first').pending).toBe(false)
    expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
    expect(playback.read('next')).toMatchObject({ text: 'b', pending: true })
    expect(frames.size).toBe(1)
    paint(240)
    await settle()
    expect(playback.read('next').pending).toBe(false)
    expect(frames.size).toBe(0)
  })

  it('counts the delay from consumption rather than a later protocol seal', async () => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('owner', [segment('open', [1], 'a', false), segment('card', [2], '')], true)
    await settle()
    paint(1)
    await settle()
    expect(frames.size).toBe(0)
    time += 100
    playback.upsert('owner', [segment('open', [1], 'a'), segment('card', [2], '')], true)
    await settle()
    expect(playback.read('open').pending).toBe(true)
    paint(139)
    await settle()
    expect(playback.read('card').entered).toBe(false)
    paint(1)
    await settle()
    expect(playback.read('open').pending).toBe(false)
    expect(playback.read('card').entered).toBe(true)
    expect(frames.size).toBe(0)
  })

  it('still requires a protocol seal after an open source has already finished its appearance delay', async () => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('owner', [segment('open', [1], 'a', false), segment('card', [2], '')], true)
    await settle()
    paint(1)
    await settle()
    time += 1000
    playback.upsert('owner', [segment('open', [1], 'a', false), segment('card', [2], '')], true)
    await settle()
    expect(playback.read('open').pending).toBe(true)
    expect(playback.read('card').entered).toBe(false)
    expect(frames.size).toBe(0)
    playback.upsert('owner', [segment('open', [1], 'a'), segment('card', [2], '')], true)
    await settle()
    expect(playback.read('open').pending).toBe(false)
    expect(playback.read('card').entered).toBe(true)
    expect(frames.size).toBe(0)
  })

  it('restarts the appearance delay only when an appended visible character is consumed', async () => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('owner', [segment('body', [1], 'a', false), segment('card', [2], '')], true)
    await settle()
    paint(1)
    await settle()
    time += 200
    playback.upsert('owner', [segment('body', [1], 'ab', false), segment('card', [2], '')], true)
    await settle()
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('ab')
    time += 20
    playback.upsert('owner', [segment('body', [1], 'ab'), segment('card', [2], '')], true)
    await settle()
    paint(219)
    await settle()
    expect(playback.read('card').entered).toBe(false)
    paint(1)
    await settle()
    expect(playback.read('card').entered).toBe(true)
  })

  it('freezes and translates an in-progress appearance delay through a background pause', async () => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('owner', [segment('body', [1], 'a'), segment('card', [2], '')], true)
    await settle()
    paint(1)
    await settle()
    paint(100)
    await settle()
    playback.pause()
    playback.pause()
    expect(frames.size).toBe(0)
    time += 60_000
    playback.upsert('owner', [segment('body', [1], 'a'), segment('card', [2], '')], true)
    await settle()
    expect(playback.read('body').pending).toBe(true)
    expect(playback.read('card').entered).toBe(false)
    playback.resume()
    playback.resume()
    await settle()
    expect(frames.size).toBe(1)
    paint(139)
    await settle()
    expect(playback.read('body').pending).toBe(true)
    paint(1)
    await settle()
    expect(playback.read('body').pending).toBe(false)
    expect(playback.read('card').entered).toBe(true)
    expect(frames.size).toBe(0)
  })

  it('does not add an appearance delay to static history, hidden reasoning, or empty atomic cards', async () => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('history', [segment('history', [0], 'history')], false)
    playback.upsert('live', [segment('hidden', [1], 'thought', true, true), segment('card', [2], ''), segment('text', [3], 'x')], true)
    await settle()
    expect(playback.read('history').pending).toBe(false)
    expect(playback.read('hidden')).toMatchObject({ text: 'thought', entered: true, pending: false })
    expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
    expect(playback.read('text').entered).toBe(false)
    paint(1)
    await settle()
    expect(playback.read('text')).toMatchObject({ text: 'x', pending: true })
  })

  it.each(['hidden', 'static'] as const)('skips an existing appearance delay when its source becomes %s', async mode => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('body', [segment('body', [1], 'a')], true)
    playback.upsert('card', [segment('card', [2], '')], true)
    await settle()
    paint(1)
    await settle()
    playback.upsert('body', [segment('body', [1], 'a', true, mode === 'hidden')], mode !== 'static')
    await settle()
    expect(playback.read('body').pending).toBe(false)
    expect(playback.read('card').entered).toBe(true)
    expect(frames.size).toBe(0)
    playback.upsert('body', [segment('body', [1], 'a')], true)
    await settle()
    expect(playback.read('body').pending).toBe(false)
    expect(frames.size).toBe(0)
  })

  it('fast-forwards appearance delays while preserving an explicit unsealed barrier', async () => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('owner', [segment('first', [1], 'a'), segment('open', [2], 'b', false), segment('card', [3], '')], true)
    await settle()
    paint(1)
    await settle()
    playback.fastForward()
    await settle()
    expect(playback.read('first').pending).toBe(false)
    expect(playback.read('open')).toMatchObject({ text: 'b', pending: true })
    expect(playback.read('card').entered).toBe(false)
    expect(frames.size).toBe(0)
    playback.upsert('owner', [segment('first', [1], 'a'), segment('open', [2], 'b'), segment('card', [3], '')], true)
    await settle()
    expect(playback.read('open').pending).toBe(false)
    expect(playback.read('card').entered).toBe(true)
    expect(frames.size).toBe(0)
  })

  it('latest skips both a frozen text target and an appearance delay already underway', async () => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('owner', [segment('first', [1], 'a'), segment('next', [2], 'b'), segment('card', [3], '')], true)
    await settle()
    paint(1)
    await settle()
    playback.pause()
    playback.beginRecovery('latest')
    playback.resume()
    await settle()
    expect(playback.read('first').pending).toBe(false)
    expect(playback.read('next')).toMatchObject({ text: 'b', pending: false })
    expect(playback.read('card').entered).toBe(true)
    expect(frames.size).toBe(0)
    playback.upsert('future', [segment('future', [4], 'c')], true)
    await settle()
    paint(1)
    await settle()
    expect(playback.read('future')).toMatchObject({ text: 'c', pending: true })
  })

  it('latest still applies the appearance delay to a newly revealed live suffix beyond its frozen frontier', async () => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.pause()
    playback.upsert('owner', [segment('body', [1], 'a'), segment('card', [2], '')], true)
    playback.beginRecovery('latest')
    playback.upsert('owner', [segment('body', [1], 'ab'), segment('card', [2], '')], true)
    playback.resume()
    await settle()
    expect(playback.read('body').text).toBe('a')
    paint(1)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 'ab', pending: true })
    expect(playback.read('card').entered).toBe(false)
    paint(239)
    await settle()
    expect(playback.read('card').entered).toBe(false)
    paint(1)
    await settle()
    expect(playback.read('card').entered).toBe(true)
    expect(frames.size).toBe(0)
  })

  it('discards a prior generation appearance delay instead of applying it to the retry', async () => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('owner', [{ ...segment('body', [1], 'a'), generation: 1 }, segment('card', [2], '')], true)
    await settle()
    paint(1)
    await settle()
    time += 100
    playback.upsert('owner', [{ ...segment('body', [1], 'b'), generation: 2 }, segment('card', [2], '')], true)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: '', entered: false, pending: true })
    paint(1)
    await settle()
    paint(239)
    await settle()
    expect(playback.read('card').entered).toBe(false)
    paint(1)
    await settle()
    expect(playback.read('card').entered).toBe(true)
  })

  it('can disable an existing appearance delay without replaying it when enabled again', async () => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('owner', [segment('body', [1], 'a'), segment('card', [2], '')], true)
    await settle()
    paint(1)
    await settle()
    playback.configure({ settleDelayMs: 0 })
    await settle()
    expect(playback.read('body').pending).toBe(false)
    expect(playback.read('card').entered).toBe(true)
    expect(frames.size).toBe(0)
    playback.configure({ settleDelayMs: 240 })
    await settle()
    expect(playback.read('body').pending).toBe(false)
    expect(frames.size).toBe(0)
  })

  it('preserves the shared Unicode catch-up budget across appearance delays', async () => {
    const playback = createPlayback(10)
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('owner', [segment('first', [1], '😀'.repeat(10)), segment('second', [2], '中'.repeat(30), false)], true)
    playback.beginRecovery('catch-up')
    await settle()
    paint(10_000)
    await settle()
    expect(Array.from(playback.read('first').text)).toHaveLength(10)
    expect(playback.read('second').entered).toBe(false)
    paint(239)
    await settle()
    expect(playback.read('second').entered).toBe(false)
    paint(80)
    await settle()
    expect(playback.read('first').pending).toBe(false)
    expect(Array.from(playback.read('second').text)).toHaveLength(16)
    expect(playback.read('second').text).not.toContain('\uFFFD')
    expect(frames.size).toBe(1)
  })

  it.each([false, true])('adopts every disabled native row across open barriers without rollback (paused: %s)', async paused => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    const values = [segment('open', [1], 'abcdef', false), segment('card', [2], ''), segment('later', [3], 'later')]
    playback.upsert('owner', values, true)
    await settle()
    paint(1)
    await settle()
    if (paused) playback.pause()
    playback.setEnabled(false)
    await settle()
    if (paused) {
      expect(playback.read('card').entered).toBe(false)
      playback.resume()
      await settle()
    }
    expect(playback.read('open')).toMatchObject({ text: 'abcdef', pending: true })
    expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
    expect(playback.read('later')).toMatchObject({ text: 'later', entered: true, pending: false })
    expect(frames.size).toBe(0)
    playback.upsert('new', [segment('new-card', [4], ''), segment('new-text', [5], 'new text')], true)
    await settle()
    expect(playback.read('new-card').entered).toBe(true)
    expect(playback.read('new-text').text).toBe('new text')
    playback.setEnabled(true)
    playback.upsert('owner', values, true)
    await settle()
    expect(playback.read('card').entered).toBe(true)
    expect(playback.read('later')).toMatchObject({ text: 'later', entered: true, pending: false })
    expect(playback.read('new-card').entered).toBe(true)
    expect(playback.read('new-text')).toMatchObject({ text: 'new text', pending: false })
    expect(frames.size).toBe(0)
  })

  it.each(['catch-up', 'latest'] as const)('retires a completed %s batch before future owners arrive', async mode => {
    const playback = createPlayback(10)
    playback.upsert('old', [segment('old', [1], 'a')], true)
    playback.beginRecovery(mode)
    await settle()
    if (mode === 'catch-up') {
      paint(80)
      await settle()
    }
    expect(playback.read('old').text).toBe('a')
    expect(frames.size).toBe(0)
    playback.upsert('new', [segment('new', [2], 'new content')], true)
    await settle()
    paint(100)
    await settle()
    expect(playback.read('new').text).toBe('n')
  })

  it('serializes presentation acknowledgements across atomic cards before revealing following text', async () => {
    const playback = createPlayback()
    const first = { ...segment('first-card', [1], ''), awaitPresentation: true }
    const second = { ...segment('second-card', [2], ''), awaitPresentation: true }
    playback.upsert('cards', [first, second, segment('body', [3], 'text')], true)
    await settle()
    expect(playback.read('first-card')).toMatchObject({ entered: true, pending: true })
    expect(playback.read('second-card')).toMatchObject({ entered: false, pending: true })
    expect(playback.read('body').entered).toBe(false)
    expect(frames.size).toBe(0)

    playback.acknowledgePresentation('first-card')
    await settle()
    expect(playback.read('first-card').pending).toBe(false)
    expect(playback.read('second-card')).toMatchObject({ entered: true, pending: true })
    expect(playback.read('body').entered).toBe(false)
    expect(frames.size).toBe(0)
    playback.acknowledgePresentation('second-card')
    await settle()
    expect(playback.read('second-card').pending).toBe(false)
    expect(frames.size).toBe(1)
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('t')
  })

  it('ignores acknowledgements before entry and from obsolete source generations', async () => {
    const playback = createPlayback()
    const first = { ...segment('first', [1], ''), awaitPresentation: true, generation: 'a' }
    const later = { ...segment('later', [2], ''), awaitPresentation: true, generation: 1 }
    playback.upsert('cards', [first, later, segment('body', [3], 'x')], true)
    playback.acknowledgePresentation('first', 'a')
    playback.acknowledgePresentation('later', 1)
    await settle()
    expect(playback.read('first').pending).toBe(true)
    playback.acknowledgePresentation('later', 1)
    playback.acknowledgePresentation('first')
    await settle()
    expect(playback.read('first').pending).toBe(true)
    playback.acknowledgePresentation('first', 'a')
    await settle()
    expect(playback.read('later')).toMatchObject({ entered: true, pending: true })

    playback.upsert('cards', [first, { ...later, generation: 2 }, segment('body', [3], 'x')], true)
    playback.acknowledgePresentation('later', 2)
    await settle()
    expect(playback.read('later')).toMatchObject({ entered: true, pending: true })
    playback.acknowledgePresentation('later', 1)
    await settle()
    expect(playback.read('later').pending).toBe(true)
    expect(playback.read('body').entered).toBe(false)
    playback.acknowledgePresentation('later', 2)
    await settle()
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('x')
  })

  it('records an acknowledgement while paused without entering a successor until resume', async () => {
    const playback = createPlayback()
    playback.upsert('cards', [
      { ...segment('first', [1], ''), awaitPresentation: true },
      { ...segment('second', [2], ''), awaitPresentation: true },
      segment('body', [3], 'x'),
    ], true)
    await settle()
    playback.pause()
    playback.acknowledgePresentation('first')
    time += 60_000
    await settle()
    expect(playback.read('first').pending).toBe(false)
    expect(playback.read('second').entered).toBe(false)
    expect(playback.read('body').entered).toBe(false)
    expect(frames.size).toBe(0)
    playback.resume()
    await settle()
    expect(playback.read('second')).toMatchObject({ entered: true, pending: true })
    playback.pause()
    playback.resume()
    await settle()
    expect(playback.read('second').pending).toBe(true)
    expect(playback.read('body').entered).toBe(false)
    playback.acknowledgePresentation('second')
    await settle()
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('x')
  })

  it.each(['hidden', 'static', 'disabled', 'fast-forward', 'latest', 'removed'] as const)(
    'releases a pending atomic predecessor when it becomes %s', async mode => {
      const playback = createPlayback()
      const card = { ...segment('card', [1], ''), awaitPresentation: true }
      playback.upsert('card', [card], true)
      playback.upsert('body', [segment('body', [2], 'x')], true)
      await settle()
      expect(playback.read('card')).toMatchObject({ entered: true, pending: true })
      if (mode === 'hidden') playback.upsert('card', [{ ...card, hidden: true }], true)
      else if (mode === 'static') playback.upsert('card', [card], false)
      else if (mode === 'disabled') playback.setEnabled(false)
      else if (mode === 'fast-forward') playback.fastForward()
      else if (mode === 'latest') playback.beginRecovery('latest')
      else playback.remove('card')
      await settle()
      expect(playback.read('card').pending).toBe(false)
      if (frames.size) {
        paint(1)
        await settle()
      }
      expect(playback.read('body')).toMatchObject({ text: 'x', entered: true, pending: false })
      if (mode === 'hidden' || mode === 'static' || mode === 'disabled') {
        playback.setEnabled(true)
        playback.upsert('card', [card], true)
        await settle()
        expect(playback.read('card').pending).toBe(false)
        expect(frames.size).toBe(0)
      }
    },
  )

  it.each(['hidden', 'static'] as const)('never arms presentation for an initially %s atomic source', async mode => {
    const playback = createPlayback()
    playback.upsert('card', [{ ...segment('card', [1], '', true, mode === 'hidden'), awaitPresentation: true }], mode !== 'static')
    playback.upsert('body', [segment('body', [2], 'x')], true)
    await settle()
    expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('x')
  })

  it('clears presentation on a paused disable and enable switch without advancing the queue', async () => {
    const playback = createPlayback()
    playback.upsert('cards', [
      { ...segment('first', [1], ''), awaitPresentation: true },
      { ...segment('second', [2], ''), awaitPresentation: true },
      segment('body', [3], 'x'),
    ], true)
    await settle()
    playback.pause()
    playback.setEnabled(false)
    playback.setEnabled(true)
    await settle()
    expect(playback.read('second').entered).toBe(false)
    expect(playback.read('body').entered).toBe(false)
    expect(frames.size).toBe(0)
    playback.resume()
    await settle()
    expect(playback.read('first').pending).toBe(false)
    expect(playback.read('second')).toMatchObject({ entered: true, pending: false })
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('x')
  })

  it('latest clears only frozen presentation targets and leaves newly registered atomic cards gated', async () => {
    const playback = createPlayback()
    const first = { ...segment('first', [1], ''), awaitPresentation: true }
    playback.upsert('first', [first], true)
    await settle()
    playback.pause()
    playback.beginRecovery('latest')
    playback.upsert('new', [
      { ...segment('new-card', [2], ''), awaitPresentation: true },
      segment('body', [3], 'x'),
    ], true)
    playback.resume()
    await settle()
    expect(playback.read('first').pending).toBe(false)
    expect(playback.read('new-card')).toMatchObject({ entered: true, pending: true })
    expect(playback.read('body').entered).toBe(false)
    expect(frames.size).toBe(0)
    playback.acknowledgePresentation('new-card')
    await settle()
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('x')
  })

  it('does not apply latest presentation recovery to a replacement generation', async () => {
    const playback = createPlayback()
    const card = { ...segment('card', [1], ''), awaitPresentation: true, generation: 1 }
    playback.upsert('owner', [card, segment('body', [2], 'x')], true)
    await settle()
    playback.pause()
    playback.beginRecovery('latest')
    playback.upsert('owner', [{ ...card, generation: 2 }, segment('body', [2], 'x')], true)
    playback.resume()
    await settle()
    expect(playback.read('card')).toMatchObject({ entered: true, pending: true })
    expect(playback.read('body').entered).toBe(false)
    playback.acknowledgePresentation('card', 1)
    await settle()
    expect(playback.read('card').pending).toBe(true)
    playback.acknowledgePresentation('card', 2)
    await settle()
    expect(playback.read('card').pending).toBe(false)
    expect(playback.read('body').text).toBe('x')
  })

  it('preserves completed acknowledgements across ordinary source updates', async () => {
    const playback = createPlayback()
    const card = { ...segment('card', [1], ''), awaitPresentation: true, generation: 1 }
    playback.upsert('owner', [card], true)
    await settle()
    playback.acknowledgePresentation('card', 1)
    await settle()
    playback.upsert('owner', [{ ...card, text: 'label' }, segment('body', [2], 'x')], true)
    await settle()
    paint(5)
    await settle()
    expect(playback.read('card')).toMatchObject({ text: 'label', entered: true, pending: false })
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('x')
  })

  it('requires both presentation acknowledgement and the existing protocol seal', async () => {
    const playback = createPlayback()
    const card = { ...segment('card', [1], '', false), awaitPresentation: true }
    playback.upsert('owner', [card, segment('body', [2], 'x')], true)
    await settle()
    playback.acknowledgePresentation('card')
    await settle()
    expect(playback.read('card').pending).toBe(true)
    expect(playback.read('body').entered).toBe(false)
    playback.upsert('owner', [{ ...card, sealed: true }, segment('body', [2], 'x')], true)
    await settle()
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('x')
  })

  it('keeps the existing text appearance delay after presentation acknowledgement', async () => {
    const playback = createPlayback()
    playback.configure({ settleDelayMs: 240 })
    playback.upsert('owner', [
      { ...segment('card', [1], 'a'), awaitPresentation: true },
      segment('body', [2], 'x'),
    ], true)
    await settle()
    paint(1)
    await settle()
    playback.acknowledgePresentation('card')
    await settle()
    expect(playback.read('card').pending).toBe(true)
    paint(239)
    await settle()
    expect(playback.read('body').entered).toBe(false)
    paint(1)
    await settle()
    expect(playback.read('card').pending).toBe(false)
    expect(playback.read('body').text).toBe('x')
  })

  it.each(['replay', 'catch-up'] as const)('retains atomic presentation gates through %s recovery', async mode => {
    const playback = createPlayback()
    playback.upsert('owner', [
      { ...segment('card', [1], ''), awaitPresentation: true },
      segment('body', [2], 'x'),
    ], true)
    await settle()
    playback.pause()
    playback.beginRecovery(mode)
    playback.resume()
    await settle()
    expect(playback.read('card')).toMatchObject({ entered: true, pending: true })
    expect(playback.read('body').entered).toBe(false)
    expect(frames.size).toBe(0)
    playback.acknowledgePresentation('card')
    await settle()
    paint(80)
    await settle()
    expect(playback.read('body').text).toBe('x')
  })

  it('ignores removed presentation callbacks before and after the id is reused by a new generation', async () => {
    const playback = createPlayback()
    const card = { ...segment('card', [1], ''), awaitPresentation: true, generation: 1 }
    playback.upsert('old-owner', [card], true)
    await settle()
    playback.remove('old-owner')
    playback.acknowledgePresentation('card', 1)
    playback.upsert('new-owner', [{ ...card, generation: 2 }, segment('body', [2], 'x')], true)
    await settle()
    playback.acknowledgePresentation('card', 1)
    await settle()
    expect(playback.read('card')).toMatchObject({ entered: true, pending: true })
    expect(playback.read('body').entered).toBe(false)
    playback.acknowledgePresentation('card', 2)
    await settle()
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('x')
  })

  it('fast-forward clears only gates reached before an unsealed predecessor', async () => {
    const playback = createPlayback()
    const values = [
      { ...segment('first', [1], ''), awaitPresentation: true },
      segment('open', [2], '', false),
      { ...segment('second', [3], ''), awaitPresentation: true },
      segment('body', [4], 'x'),
    ]
    playback.upsert('owner', values, true)
    await settle()
    playback.fastForward()
    await settle()
    expect(playback.read('first').pending).toBe(false)
    expect(playback.read('open')).toMatchObject({ entered: true, pending: true })
    expect(playback.read('second').entered).toBe(false)
    playback.upsert('owner', values.map(value => value.id === 'open' ? { ...value, sealed: true } : value), true)
    await settle()
    expect(playback.read('second')).toMatchObject({ entered: true, pending: true })
    expect(playback.read('body').entered).toBe(false)
    playback.acknowledgePresentation('second')
    await settle()
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('x')
  })
})
