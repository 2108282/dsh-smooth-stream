import { DEFAULT_STREAM_DEBUG_TUNING, type BackgroundRecovery, type StreamDebugTuning } from '../settings.ts'
import { recoveryBudget } from './backgroundRecovery.ts'

export interface PlaybackSegment {
  id: string
  order: readonly number[]
  text: string
  sealed: boolean
  hidden?: boolean
  /** Hold the queue after entry until the visible atomic presentation acknowledges completion. */
  awaitPresentation?: boolean
  /** Explicit source identity; a changed generation never inherits reveal progress. */
  generation?: string | number
}

export interface PlaybackDisplay {
  text: string
  entered: boolean
  pending: boolean
}

export interface PlaybackConfiguration {
  charsPerSecond?: number
  maxLagChars?: number
  /** Hold visible animated text until its final character has finished appearing. */
  settleDelayMs?: number
  tuning?: Partial<StreamDebugTuning>
}

export interface SessionPlaybackOptions extends PlaybackConfiguration {
  requestFrame?: (callback: (time: number) => void) => number
  cancelFrame?: (handle: number) => void
  now?: () => number
}

interface RecoveryTarget {
  epoch: number
  length: number
}

interface RecoveryBatch {
  mode: BackgroundRecovery
  frontier: Map<string, RecoveryTarget>
}

interface SegmentState {
  generation: string | number | undefined
  epoch: number
  animate: boolean
  text: string
  points: string[]
  displayText: string
  consumed: number
  lastRevealAt: number | undefined
  sealed: boolean
  hidden: boolean
  entered: boolean
  presentationPending: boolean
  fraction: number
  touched: number
}

const EMPTY_DISPLAY: PlaybackDisplay = Object.freeze({ text: '', entered: false, pending: false })
const LEDGER_LIMIT = 2048
const DEFAULT_CHARS_PER_SECOND = 60
const DEFAULT_MAX_LAG_CHARS = 256

function compareOrder(left: readonly number[], right: readonly number[]): number {
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index++) {
    const a = left[index]!
    const b = right[index]!
    if (a < b) return -1
    if (a > b) return 1
  }
  return left.length - right.length
}

function startsWith<T>(value: readonly T[], prefix: readonly T[]): boolean {
  if (prefix.length > value.length) return false
  for (let index = 0; index < prefix.length; index++) {
    if (value[index] !== prefix[index]) return false
  }
  return true
}

/** A single-clock playback queue shared by every owner in one session. */
export class SessionPlayback {
  private readonly requestFrame: (callback: (time: number) => void) => number
  private readonly cancelFrame: (handle: number) => void
  private readonly now: () => number
  private charsPerSecond = DEFAULT_CHARS_PER_SECOND
  private maxLagChars = DEFAULT_MAX_LAG_CHARS
  private settleDelayMs = 0
  private tuning: StreamDebugTuning = { ...DEFAULT_STREAM_DEBUG_TUNING }
  private paused = false
  private pausedAt: number | undefined
  private recovery: RecoveryBatch | undefined
  private recoveryDebt = 0
  private readonly owners = new Map<string, Map<string, PlaybackSegment>>()
  private readonly states = new Map<string, SegmentState>()
  private readonly active = new Map<string, PlaybackSegment>()
  private ordered: PlaybackSegment[] = []
  private readonly dirtyDisplays = new Set<string>()
  private readonly displays = new Map<string, PlaybackDisplay>()
  private readonly listeners = new Set<() => void>()
  private enabled = true
  private disposed = false
  private initialSealed = false
  private frame: number | undefined
  private lastFrameTime: number | undefined
  private wholeChars = 0
  private revision = 0
  private pumpQueued = false
  private publishQueued = false
  private touchSequence = 0

  constructor(options: SessionPlaybackOptions = {}) {
    this.requestFrame = options.requestFrame
      ?? (callback => globalThis.requestAnimationFrame(callback))
    this.cancelFrame = options.cancelFrame
      ?? (handle => globalThis.cancelAnimationFrame(handle))
    this.now = options.now ?? (() => globalThis.performance.now())
    this.applyConfiguration(options)
  }

  /** Arrow fields keep these methods safe to pass directly to useSyncExternalStore. */
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getRevision = (): number => this.revision

  readonly read = (id: string): PlaybackDisplay => this.displays.get(id) ?? EMPTY_DISPLAY

  upsert(owner: string, segments: readonly PlaybackSegment[], animate: boolean): void {
    if (this.disposed) return
    const next = new Map<string, PlaybackSegment>()
    for (const source of segments) {
      const segment: PlaybackSegment = {
        id: source.id,
        order: [...source.order],
        text: source.text,
        sealed: source.sealed,
        hidden: source.hidden === true,
        awaitPresentation: source.awaitPresentation === true,
        ...(source.generation === undefined ? {} : { generation: source.generation }),
      }
      next.set(segment.id, segment)
      this.updateState(segment, animate)
    }
    this.owners.set(owner, next)
    this.rebuildActive()
    if (!this.enabled && !this.paused) this.adoptAll()
    else this.queuePump()
    this.trimLedger()
  }

  /** Only an entered source in the same generation can release its presentation barrier. */
  acknowledgePresentation(id: string, generation?: string | number): void {
    if (this.disposed || !this.active.has(id)) return
    const state = this.states.get(id)
    if (!state?.entered || !state.presentationPending || state.generation !== generation) return
    this.clearPresentation(id, state)
    this.recoveryTarget(id, state)
    this.queuePump()
  }

  remove(owner: string): void {
    if (this.disposed || !this.owners.delete(owner)) return
    this.rebuildActive()
    this.queuePump()
    this.trimLedger()
  }

  /** Marks the initial owner-registration phase as complete; pumping stays microtask-batched. */
  sealInitial(): void {
    if (this.disposed || this.initialSealed) return
    this.initialSealed = true
    this.queuePump()
  }

  /** Freeze presentation without dropping incoming targets or accumulating frame debt. */
  pause(): void {
    if (this.disposed || this.paused) return
    this.paused = true
    this.pausedAt = this.now()
    this.cancelPendingFrame()
    this.resetClock()
  }

  resume(): void {
    if (this.disposed || !this.paused) return
    const pausedFor = Math.max(0, this.now() - (this.pausedAt ?? this.now()))
    for (const state of this.states.values()) if (state.lastRevealAt !== undefined) state.lastRevealAt += pausedFor
    this.paused = false
    this.pausedAt = undefined
    this.resetClock()
    for (const segment of this.ordered) this.applyImmediateState(segment.id, this.states.get(segment.id)!)
    if (!this.enabled) this.adoptAll()
    else this.queuePump()
  }

  /** Runtime configuration preserves each source's current reveal position. */
  configure(configuration: PlaybackConfiguration): void {
    if (this.disposed || !this.applyConfiguration(configuration)) return
    this.cancelPendingFrame()
    this.resetClock()
    this.queuePump()
  }

  /** Capture a finite frontier: later deltas never extend this recovery batch. */
  beginRecovery(mode: BackgroundRecovery): void {
    if (this.disposed) return
    const frontier = new Map<string, RecoveryTarget>()
    for (const segment of this.ordered) {
      const state = this.states.get(segment.id)!
      if (mode === 'latest' && state.lastRevealAt !== undefined) {
        state.lastRevealAt = undefined
        this.dirtyDisplays.add(segment.id)
      }
      if (!state.entered || state.consumed < state.points.length || state.presentationPending) {
        frontier.set(segment.id, { epoch: state.epoch, length: state.points.length })
      }
    }
    this.recovery = frontier.size > 0 ? { mode, frontier } : undefined
    this.cancelPendingFrame()
    this.resetClock()
    this.queuePump()
  }

  setRecovery(mode: BackgroundRecovery): void {
    this.beginRecovery(mode)
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      for (const [id, state] of this.states) this.clearPresentation(id, state)
      this.queuePublish()
    }
    if (this.paused) return
    if (enabled) {
      this.queuePump()
    } else {
      this.adoptAll()
    }
  }

  /** Disabled rendering exposes every native row, including successors of an open source. */
  private adoptAll(): void {
    this.cancelPendingFrame()
    this.resetClock()
    this.recovery = undefined
    for (const segment of this.ordered) {
      const state = this.states.get(segment.id)!
      this.clearPresentation(segment.id, state)
      this.enterState(segment.id, state)
      this.consumeTo(segment.id, state, state.points.length, false)
      state.fraction = 0
    }
    this.queuePublish()
  }

  /** Catch up in order, but never cross an unsealed protocol boundary. */
  fastForward(): void {
    if (this.disposed) return
    this.cancelPendingFrame()
    this.resetClock()
    this.recovery = undefined
    for (const segment of this.ordered) {
      const state = this.states.get(segment.id)!
      this.clearPresentation(segment.id, state)
      this.enterState(segment.id, state)
      this.consumeTo(segment.id, state, state.points.length, false)
      state.fraction = 0
      if (!state.sealed) break
    }
    this.queuePublish()
    if (this.enabled) this.queuePump()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelPendingFrame()
    this.resetClock()
    this.owners.clear()
    this.active.clear()
    this.ordered = []
    this.dirtyDisplays.clear()
    this.states.clear()
    this.displays.clear()
    this.listeners.clear()
    this.recovery = undefined
  }

  private applyConfiguration(configuration: PlaybackConfiguration): boolean {
    let changed = false
    if (Number.isFinite(configuration.charsPerSecond) && configuration.charsPerSecond! > 0
      && this.charsPerSecond !== configuration.charsPerSecond) {
      this.charsPerSecond = configuration.charsPerSecond!
      changed = true
    }
    if (Number.isFinite(configuration.maxLagChars)) {
      const maxLagChars = Math.max(DEFAULT_MAX_LAG_CHARS, Math.ceil(configuration.maxLagChars!))
      if (this.maxLagChars !== maxLagChars) {
        this.maxLagChars = maxLagChars
        changed = true
      }
    }
    if (Number.isFinite(configuration.settleDelayMs) && configuration.settleDelayMs! >= 0
      && this.settleDelayMs !== configuration.settleDelayMs) {
      this.settleDelayMs = configuration.settleDelayMs!
      for (const [id, state] of this.states) {
        if (state.lastRevealAt === undefined) continue
        if (this.settleDelayMs === 0) state.lastRevealAt = undefined
        this.dirtyDisplays.add(id)
      }
      changed = true
    }
    if (configuration.tuning) {
      for (const key of Object.keys(DEFAULT_STREAM_DEBUG_TUNING) as (keyof StreamDebugTuning)[]) {
        const value = configuration.tuning[key]
        const permitsZero = key === 'queuePressure' || key === 'runwayPx' || key === 'reserveResponseMs'
        if (value !== undefined && Number.isFinite(value) && (permitsZero ? value >= 0 : value > 0)
          && this.tuning[key] !== value) {
          this.tuning[key] = value
          changed = true
        }
      }
    }
    return changed
  }

  private updateState(segment: PlaybackSegment, animate: boolean): void {
    let state = this.states.get(segment.id)
    const wasHidden = state?.hidden ?? false
    const nextPoints = Array.from(segment.text)
    const presentationPending = this.enabled && animate && !segment.hidden && segment.awaitPresentation === true
    if (state === undefined) {
      state = {
        generation: segment.generation,
        epoch: 0,
        animate,
        text: segment.text,
        points: nextPoints,
        displayText: '',
        consumed: 0,
        lastRevealAt: undefined,
        sealed: segment.sealed,
        hidden: segment.hidden === true,
        entered: false,
        presentationPending,
        fraction: 0,
        touched: ++this.touchSequence,
      }
      this.states.set(segment.id, state)
    } else {
      const previousPoints = state.points
      const retry = state.generation !== segment.generation || (state.sealed && !segment.sealed)
      if (retry) {
        state.epoch++
        this.cancelPendingFrame()
        this.resetClock()
        state.consumed = 0
        state.lastRevealAt = undefined
        state.displayText = ''
        state.entered = false
        state.presentationPending = presentationPending
        state.fraction = 0
      } else if (state.text !== segment.text) {
        if (startsWith(nextPoints, previousPoints)) {
          state.consumed = Math.min(state.consumed, previousPoints.length)
        } else if (!this.paused && state.sealed && state.consumed >= previousPoints.length) {
          // A replacement of completed history is adopted without replaying it.
          state.consumed = nextPoints.length
          state.lastRevealAt = undefined
          state.displayText = state.entered ? segment.text : ''
        } else {
          state.epoch++
          state.consumed = 0
          state.lastRevealAt = undefined
          state.displayText = ''
          state.fraction = 0
        }
      }
      state.generation = segment.generation
      state.animate = animate
      state.text = segment.text
      state.points = nextPoints
      state.sealed = segment.sealed
      state.hidden = segment.hidden === true
      state.touched = ++this.touchSequence
    }

    if (!presentationPending) this.clearPresentation(segment.id, state)
    if (!this.paused) this.applyImmediateState(segment.id, state)
    if (!state.hidden && wasHidden && !state.entered) {
      state.consumed = 0
      state.displayText = ''
      state.fraction = 0
    }
    this.dirtyDisplays.add(segment.id)
    this.recoveryTarget(segment.id, state)
  }

  private applyImmediateState(id: string, state: SegmentState): void {
    if (!state.animate) {
      state.lastRevealAt = undefined
      state.entered = true
      state.consumed = state.points.length
      state.displayText = state.text
      state.fraction = 0
      this.dirtyDisplays.add(id)
    } else if (state.hidden) {
      state.lastRevealAt = undefined
      state.consumed = state.points.length
      if (state.entered) state.displayText = state.text
      state.fraction = 0
      this.dirtyDisplays.add(id)
    }
  }

  private rebuildActive(): void {
    const previousIds = new Set(this.active.keys())
    this.active.clear()
    for (const owner of this.owners.values()) {
      for (const [id, segment] of owner) this.active.set(id, segment)
    }
    for (const id of previousIds) if (!this.active.has(id)) this.dirtyDisplays.add(id)
    for (const id of this.active.keys()) if (!previousIds.has(id)) this.dirtyDisplays.add(id)
    this.ordered = [...this.active.values()].sort((left, right) =>
      compareOrder(left.order, right.order) || left.id.localeCompare(right.id))
    const recovery = this.recovery
    if (recovery) {
      for (const id of recovery.frontier.keys()) {
        const state = this.states.get(id)
        if (!this.active.has(id) || !state) recovery.frontier.delete(id)
        else this.recoveryTarget(id, state)
      }
      if (recovery.frontier.size === 0) this.recovery = undefined
    }
  }

  private recoveryTarget(id: string, state: SegmentState): RecoveryTarget | undefined {
    const target = this.recovery?.frontier.get(id)
    if (!target) return undefined
    if (target.epoch !== state.epoch || (state.entered && state.consumed >= target.length && !state.presentationPending)) {
      this.recovery!.frontier.delete(id)
      if (this.recovery!.frontier.size === 0) {
        this.recovery = undefined
        this.recoveryDebt = 0
      }
      return undefined
    }
    return target
  }

  private isSettling(state: SegmentState): boolean {
    return state.lastRevealAt !== undefined && state.animate && !state.hidden
      && (this.pausedAt ?? this.now()) - state.lastRevealAt < this.settleDelayMs
  }

  private isComplete(state: SegmentState): boolean {
    return state.entered && state.consumed >= state.points.length && state.sealed
      && !state.presentationPending && !this.isSettling(state)
  }

  private clearPresentation(id: string, state: SegmentState): void {
    if (!state.presentationPending) return
    state.presentationPending = false
    this.dirtyDisplays.add(id)
  }

  private enterState(id: string, state: SegmentState): void {
    if (state.entered) return
    state.entered = true
    state.displayText = state.points.slice(0, state.consumed).join('')
    this.dirtyDisplays.add(id)
  }

  private consumeTo(id: string, state: SegmentState, consumed: number, settle = true): void {
    if (!settle && state.lastRevealAt !== undefined) {
      state.lastRevealAt = undefined
      this.dirtyDisplays.add(id)
    }
    if (consumed <= state.consumed) return
    const previous = state.consumed
    state.consumed = consumed
    if (state.entered) state.displayText += state.points.slice(previous, consumed).join('')
    state.lastRevealAt = settle && state.animate && !state.hidden && this.settleDelayMs > 0 ? this.now() : undefined
    this.dirtyDisplays.add(id)
  }

  private queuePump(): void {
    if (this.pumpQueued || this.disposed) return
    this.pumpQueued = true
    queueMicrotask(() => {
      this.pumpQueued = false
      if (this.disposed) return
      this.pump()
    })
  }

  private pump(): void {
    if (this.paused) {
      this.queuePublish()
      return
    }
    for (const segment of this.ordered) {
      const state = this.states.get(segment.id)!
      if (this.isComplete(state)) {
        if (state.lastRevealAt !== undefined) {
          state.lastRevealAt = undefined
          this.dirtyDisplays.add(segment.id)
        }
        continue
      }
      const target = this.recoveryTarget(segment.id, state)
      if (this.recovery?.mode === 'latest' && target) {
        this.clearPresentation(segment.id, state)
        this.enterState(segment.id, state)
        this.consumeTo(segment.id, state, Math.min(target.length, state.points.length), false)
        this.recoveryTarget(segment.id, state)
        if (this.isComplete(state)) continue
      }
      if (state.hidden) {
        this.enterState(segment.id, state)
        this.consumeTo(segment.id, state, state.points.length)
        this.recoveryTarget(segment.id, state)
        if (state.sealed) continue
        break
      }
      if (state.points.length === 0) {
        this.enterState(segment.id, state)
        this.recoveryTarget(segment.id, state)
        if (this.isComplete(state)) continue
      }
      break
    }
    this.queuePublish()
    this.ensureFrame()
  }

  private ensureFrame(): void {
    const head = this.firstIncomplete()
    const state = head ? this.states.get(head.id)! : undefined
    const needsFrame = this.enabled && !this.paused && state !== undefined && !state.hidden
      && (state.consumed < state.points.length || (state.sealed && this.isSettling(state)))
    if (!needsFrame) {
      if (this.frame !== undefined) this.cancelPendingFrame()
      this.resetClock()
      return
    }
    if (this.frame !== undefined) return
    if (this.lastFrameTime === undefined) this.lastFrameTime = this.now()
    this.frame = this.requestFrame(() => this.onFrame())
  }

  private onFrame(): void {
    this.frame = undefined
    if (this.disposed || !this.enabled || this.paused) return
    const timestamp = this.now()
    const previous = this.lastFrameTime ?? timestamp
    const elapsed = Math.max(0, timestamp - previous)
    this.lastFrameTime = timestamp
    const head = this.firstIncomplete()
    const headState = head ? this.states.get(head.id)! : undefined
    const target = head && headState ? this.recoveryTarget(head.id, headState) : undefined
    const catchingUp = this.recovery?.mode === 'catch-up' && target !== undefined
    let budget: number
    if (catchingUp) {
      let backlog = 0
      for (const [id, frontier] of this.recovery!.frontier) {
        const state = this.states.get(id)
        if (state?.epoch === frontier.epoch) backlog += Math.max(0, Math.min(frontier.length, state.points.length) - state.consumed)
      }
      const step = recoveryBudget(backlog, elapsed, this.recoveryDebt, this.tuning, true)
      budget = step.chars
      this.recoveryDebt = step.debt
    } else {
      const backlog = headState ? headState.points.length - headState.consumed : 0
      const pressure = 1 + Math.min(1, backlog / this.maxLagChars) * this.tuning.queuePressure
      const cps = Math.min(this.tuning.maxRevealCps, this.charsPerSecond * this.tuning.revealScale * pressure)
      const accumulated = Math.min(this.maxLagChars, this.wholeChars + Math.min(elapsed, 120) * cps / 1000)
      budget = Math.min(Math.max(1, Math.floor(this.tuning.cadenceClamp)), Math.floor(accumulated))
      // Clamp whole-character debt away, preserving only sub-character cadence.
      this.wholeChars = accumulated % 1
    }

    const ordered = this.ordered
    let index = 0
    while (index < ordered.length) {
      const segment = ordered[index]!
      const state = this.states.get(segment.id)!
      if (this.isComplete(state)) {
        index++
        continue
      }
      if (state.hidden) {
        this.enterState(segment.id, state)
        this.consumeTo(segment.id, state, state.points.length)
        this.recoveryTarget(segment.id, state)
        if (state.sealed) {
          index++
          continue
        }
        break
      }
      const frontier = this.recoveryTarget(segment.id, state)
      const recoveryMode = frontier ? this.recovery?.mode : undefined
      if (recoveryMode === 'latest') break
      if ((recoveryMode === 'catch-up') !== catchingUp && state.consumed < state.points.length) break
      this.enterState(segment.id, state)
      if (state.points.length === 0) {
        this.recoveryTarget(segment.id, state)
        if (this.isComplete(state)) {
          index++
          continue
        }
        break
      }
      if (budget <= 0) break
      const limit = catchingUp && frontier ? Math.min(frontier.length, state.points.length) : state.points.length
      const amount = Math.min(budget, Math.max(0, limit - state.consumed))
      this.consumeTo(segment.id, state, state.consumed + amount)
      this.recoveryTarget(segment.id, state)
      budget -= amount
      if (this.isComplete(state)) {
        index++
        continue
      }
      // A caught-up open source remains a protocol barrier; a frozen frontier
      // also ends accelerated playback before any newly appended live suffix.
      break
    }

    this.pump()
  }

  private firstIncomplete(): PlaybackSegment | undefined {
    for (const segment of this.ordered) {
      const state = this.states.get(segment.id)!
      if (!this.isComplete(state)) return segment
    }
    return undefined
  }

  private cancelPendingFrame(): void {
    if (this.frame === undefined) return
    this.cancelFrame(this.frame)
    this.frame = undefined
  }

  private resetClock(): void {
    this.lastFrameTime = undefined
    this.wholeChars = 0
    this.recoveryDebt = 0
  }

  private queuePublish(): void {
    if (this.publishQueued || this.disposed || this.dirtyDisplays.size === 0) return
    this.publishQueued = true
    queueMicrotask(() => {
      this.publishQueued = false
      if (this.disposed) return
      const dirty = [...this.dirtyDisplays]
      this.dirtyDisplays.clear()
      let changed = false
      for (const id of dirty) {
        const segment = this.active.get(id)
        const state = this.states.get(id)
        const next = segment && state
          ? {
              text: state.entered ? state.displayText : '',
              entered: state.entered,
              pending: !this.isComplete(state),
            }
          : EMPTY_DISPLAY
        const previous = this.displays.get(id) ?? EMPTY_DISPLAY
        if (previous.text === next.text && previous.entered === next.entered && previous.pending === next.pending) {
          if (!segment || !state) this.displays.delete(id)
          continue
        }
        if (segment && state) this.displays.set(id, next)
        else this.displays.delete(id)
        changed = true
      }
      if (!changed) return
      this.revision++
      for (const listener of [...this.listeners]) listener()
    })
  }

  private trimLedger(): void {
    if (this.states.size <= LEDGER_LIMIT) return
    const active = new Set(this.active.keys())
    const candidates = [...this.states.entries()]
      .filter(([id]) => !active.has(id))
      .sort((left, right) => left[1].touched - right[1].touched)
    for (const [id] of candidates) {
      if (this.states.size <= LEDGER_LIMIT) break
      this.states.delete(id)
    }
  }
}
