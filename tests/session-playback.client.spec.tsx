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

  it.each(['append', 'insert-child'] as const)(
    'rehides entered successors when a completed predecessor grows by %s', async (change: 'append' | 'insert-child') => {
      const playback = createPlayback()
      playback.upsert('owner', [
        segment('first', [1], 'a'),
        segment('card', [2], ''),
        segment('tail', [3], 'later'),
      ], true)
      await settle()
      paint(20)
      await settle()
      expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
      expect(playback.read('tail')).toMatchObject({ text: 'later', entered: true, pending: false })

      playback.upsert('owner', change === 'append' ? [
        segment('first', [1], 'a-tail'),
        segment('card', [2], ''),
        segment('tail', [3], 'later'),
      ] : [
        segment('first', [1], 'a'),
        segment('child', [1, 1], 'new child'),
        segment('card', [2], ''),
        segment('tail', [3], 'later'),
      ], true)
      await settle()
      expect(playback.read('card')).toMatchObject({ text: '', entered: false, pending: true })
      expect(playback.read('tail')).toMatchObject({ text: '', entered: false, pending: true })

      paint(20)
      await settle()
      if (change === 'append') {
        expect(playback.read('first')).toMatchObject({ text: 'a-tail', pending: false })
      } else {
        expect(playback.read('child')).toMatchObject({ text: 'new child', pending: false })
      }
      expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
      expect(playback.read('tail')).toMatchObject({ text: 'later', entered: true, pending: false })
    },
  )

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

  it('caps ordinary reveal bursts at 256 code points even when configured lower', async () => {
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

  it('requires a protocol seal after an open source has consumed all current text', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [segment('open', [1], 'a', false), segment('card', [2], '')], true)
    await settle()
    paint(1)
    await settle()
    expect(playback.read('open')).toMatchObject({ text: 'a', pending: true })
    expect(playback.read('card').entered).toBe(false)
    expect(frames.size).toBe(0)

    playback.upsert('owner', [segment('open', [1], 'a'), segment('card', [2], '')], true)
    await settle()
    expect(playback.read('open').pending).toBe(false)
    expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
    expect(frames.size).toBe(0)
  })

  it('keeps static history, hidden reasoning, and empty atomic cards outside text reveal', async () => {
    const playback = createPlayback()
    playback.upsert('history', [segment('history', [0], 'history')], false)
    playback.upsert('live', [segment('hidden', [1], 'thought', true, true), segment('card', [2], ''), segment('text', [3], 'x')], true)
    await settle()
    expect(playback.read('history').pending).toBe(false)
    expect(playback.read('hidden')).toMatchObject({ text: 'thought', entered: true, pending: false })
    expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
    expect(playback.read('text').entered).toBe(false)
    paint(1)
    await settle()
    expect(playback.read('text')).toMatchObject({ text: 'x', pending: false })
  })

  it.each(['hidden', 'static'] as const)('adopts an existing source when it becomes %s without replaying it', async (mode: 'hidden' | 'static') => {
    const playback = createPlayback()
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

  it('fast-forwards visible content while preserving an explicit unsealed barrier', async () => {
    const playback = createPlayback()
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

  it('resets reveal progress for a replacement generation', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [{ ...segment('body', [1], 'a'), generation: 1 }, segment('card', [2], '')], true)
    await settle()
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('a')
    expect(playback.read('card').entered).toBe(true)

    playback.upsert('owner', [{ ...segment('body', [1], 'b'), generation: 2 }, segment('card', [2], '')], true)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: '', entered: false, pending: true })
    paint(1)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 'b', entered: true, pending: false })
    expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
  })

  it('adopts every disabled native row across open barriers without rollback', async () => {
    const playback = createPlayback()
    const values = [segment('open', [1], 'abcdef', false), segment('card', [2], ''), segment('later', [3], 'later')]
    playback.upsert('owner', values, true)
    await settle()
    paint(1)
    await settle()
    playback.setEnabled(false)
    await settle()
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

  it.each(['hidden', 'static', 'disabled', 'fast-forward', 'removed'] as const)(
    'releases a pending atomic predecessor when it becomes %s', async (mode: 'hidden' | 'static' | 'disabled' | 'fast-forward' | 'removed') => {
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

  it.each(['hidden', 'static'] as const)('never arms presentation for an initially %s atomic source', async (mode: 'hidden' | 'static') => {
    const playback = createPlayback()
    playback.upsert('card', [{ ...segment('card', [1], '', true, mode === 'hidden'), awaitPresentation: true }], mode !== 'static')
    playback.upsert('body', [segment('body', [2], 'x')], true)
    await settle()
    expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
    paint(1)
    await settle()
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

  it('adopts a running history baseline without sealing it and animates later appends', async () => {
    const playback = createPlayback()
    const source = { ...segment('body', [1], 'history', false), baselineChars: 7 }
    playback.upsert('owner', [source, segment('card', [2], '')], true)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 'history', entered: true, pending: true })
    expect(playback.read('card').entered).toBe(false)
    expect(frames.size).toBe(0)

    playback.upsert('owner', [{ ...source, text: 'historyab' }, segment('card', [2], '')], true)
    await settle()
    expect(playback.read('body').text).toBe('history')
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('historya')
    paint(1)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 'historyab', pending: true })
    playback.upsert('owner', [{ ...source, text: 'historyab', sealed: true }, segment('card', [2], '')], true)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 'historyab', pending: false })
    expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
    expect(frames.size).toBe(0)
  })

  it('shows only the entry prefix when history and the first live packet merge before registration', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [
      { ...segment('body', [1], 'oldnew'), baselineChars: 3 },
      { ...segment('history-card', [2], ''), baselineChars: 0, awaitPresentation: true },
      { ...segment('live-card', [3], ''), awaitPresentation: true },
      segment('tail', [4], 'x'),
    ], true)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 'old', entered: true, pending: true })
    expect(playback.read('history-card')).toMatchObject({ entered: true, pending: false })
    expect(playback.read('live-card').entered).toBe(false)
    paint(3)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 'oldnew', pending: false })
    expect(playback.read('live-card')).toMatchObject({ entered: true, pending: true })
    expect(playback.read('tail').entered).toBe(false)
    playback.acknowledgePresentation('live-card')
    await settle()
    paint(1)
    await settle()
    expect(playback.read('tail').text).toBe('x')
  })

  it('adopts complete history baselines without a presentation barrier', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [
      { ...segment('history', [1], 'past'), baselineChars: 4 },
      { ...segment('card', [2], ''), baselineChars: 0, awaitPresentation: true },
      segment('live', [3], 'now'),
    ], true)
    await settle()
    expect(playback.read('history')).toMatchObject({ text: 'past', entered: true, pending: false })
    expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
    expect(playback.read('live')).toMatchObject({ text: '', entered: false, pending: true })
    paint(1)
    await settle()
    expect(playback.read('live').text).toBe('n')
  })

  it('distinguishes an empty history baseline from an unmarked live atomic card', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [
      segment('open', [1], 'a', false),
      { ...segment('history-card', [2], ''), baselineChars: 0, awaitPresentation: true },
      { ...segment('live-card', [3], ''), awaitPresentation: true },
    ], true)
    await settle()
    expect(playback.read('history-card')).toMatchObject({ entered: true, pending: false })
    expect(playback.read('live-card')).toMatchObject({ entered: false, pending: true })
    paint(1)
    await settle()
    expect(playback.read('live-card').entered).toBe(false)
    playback.upsert('owner', [
      segment('open', [1], 'a'),
      { ...segment('history-card', [2], ''), baselineChars: 0, awaitPresentation: true },
      { ...segment('live-card', [3], ''), awaitPresentation: true },
    ], true)
    await settle()
    expect(playback.read('live-card')).toMatchObject({ entered: true, pending: true })
  })

  it('does not let a zero baseline enter nonempty live text before an open predecessor', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [
      segment('open', [1], 'a', false),
      { ...segment('live', [2], 'new'), baselineChars: 0 },
    ], true)
    await settle()
    expect(playback.read('live')).toMatchObject({ text: '', entered: false, pending: true })
    paint(1)
    await settle()
    expect(playback.read('live')).toMatchObject({ text: '', entered: false, pending: true })
    expect(frames.size).toBe(0)
  })

  it('counts baseline prefixes as Unicode code points and animates whole suffix points', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [{ ...segment('body', [1], '😀中🚀x'), baselineChars: 2 }], true)
    await settle()
    expect(playback.read('body').text).toBe('😀中')
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('😀中🚀')
    paint(1)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: '😀中🚀x', pending: false })
  })

  it('clamps oversized baselines to the current code point length', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [{ ...segment('body', [1], '😀x'), baselineChars: 999 }], true)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: '😀x', entered: true, pending: false })
    expect(frames.size).toBe(0)
  })

  it('never rolls back ordinary reveal progress when baselines become smaller', async () => {
    const playback = createPlayback()
    const source = { ...segment('body', [1], 'oldnew'), baselineChars: 3 }
    playback.upsert('owner', [source, segment('card', [2], '')], true)
    await settle()
    paint(2)
    await settle()
    expect(playback.read('body').text).toBe('oldne')
    playback.upsert('owner', [{ ...source, baselineChars: 1 }, segment('card', [2], '')], true)
    await settle()
    expect(playback.read('body').text).toBe('oldne')
    paint(1)
    await settle()
    playback.upsert('owner', [source, segment('card', [2], '')], true)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 'oldnew', pending: false })
    expect(playback.read('card')).toMatchObject({ entered: true, pending: false })
  })

  it('does not inherit a baseline across generations and applies a replacement generation baseline after reset', async () => {
    const playback = createPlayback()
    const source = { ...segment('body', [1], 'oldnew', false), baselineChars: 3, generation: 1 }
    playback.upsert('owner', [source], true)
    await settle()
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('oldn')
    playback.upsert('owner', [{ ...segment('body', [1], 'oldnew', false), generation: 2 }], true)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: '', entered: false, pending: true })
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('o')
    playback.upsert('owner', [{ ...source, text: 'replacement', baselineChars: 2, generation: 3 }], true)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 're', entered: true, pending: true })
  })

  it('applies a new baseline after a non-prefix text reset', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [{ ...segment('body', [1], 'oldnew', false), baselineChars: 3 }], true)
    await settle()
    playback.upsert('owner', [{ ...segment('body', [1], 'replacement', false), baselineChars: 2 }], true)
    await settle()
    expect(playback.read('body').text).toBe('re')
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('rep')
  })

  it('keeps a small baseline from limiting immediate static history', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [{ ...segment('body', [1], 'history'), baselineChars: 2 }], false)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 'history', entered: true, pending: false })
    expect(frames.size).toBe(0)
  })

  it('shows a new generation baseline before an open predecessor seals while its suffix waits in order', async () => {
    const playback = createPlayback()
    playback.upsert('owner', [
      segment('open', [1], 'a', false),
      { ...segment('body', [2], 'oldnew', false), baselineChars: 3, generation: 1 },
    ], true)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 'old', entered: true, pending: true })
    paint(1)
    await settle()
    expect(frames.size).toBe(0)
    playback.upsert('owner', [
      segment('open', [1], 'a', false),
      { ...segment('body', [2], 'retrytail', false), baselineChars: 5, generation: 2 },
    ], true)
    await settle()
    expect(playback.read('body')).toMatchObject({ text: 'retry', entered: true, pending: true })
    expect(frames.size).toBe(0)
    playback.upsert('owner', [
      segment('open', [1], 'a'),
      { ...segment('body', [2], 'retrytail', false), baselineChars: 5, generation: 2 },
    ], true)
    await settle()
    paint(1)
    await settle()
    expect(playback.read('body').text).toBe('retryt')
  })

  it('shares the ordinary Unicode frame budget across owners', async () => {
    const playback = createPlayback()
    playback.configure({ tuning: { cadenceClamp: 3 } })
    playback.upsert('first', [segment('first', [1], '😀中')], true)
    playback.upsert('second', [segment('second', [2], '🚀abc', false)], true)
    await settle()
    paint(10_000)
    await settle()
    expect(playback.read('first')).toMatchObject({ text: '😀中', pending: false })
    expect(playback.read('second').text).toBe('🚀')
    paint(1)
    await settle()
    expect(playback.read('second').text).toBe('🚀a')
  })

  it('limits long frame gaps to ordinary elapsed and per-frame budgets without recovery debt', async () => {
    const playback = createPlayback(100)
    playback.upsert('owner', [{ ...segment('body', [1], 'old' + 'x'.repeat(500), false), baselineChars: 3 }], true)
    await settle()
    paint(60_000)
    await settle()
    expect(playback.read('body').text).toBe('old' + 'x'.repeat(12))
    paint(10)
    await settle()
    expect(playback.read('body').text).toBe('old' + 'x'.repeat(13))
    playback.configure({ tuning: { cadenceClamp: 3 } })
    await settle()
    paint(60_000)
    await settle()
    expect(playback.read('body').text).toBe('old' + 'x'.repeat(16))
    paint(10)
    await settle()
    expect(playback.read('body').text).toBe('old' + 'x'.repeat(17))
  })
})
