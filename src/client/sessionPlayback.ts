import { DEFAULT_STREAM_DEBUG_TUNING, type StreamDebugTuning } from '../settings.ts'

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
  /** Already visible entry prefix, in Unicode code points; zero also marks empty history. */
  baselineChars?: number
}

export interface PlaybackDisplay {
  text: string
  entered: boolean
  pending: boolean
}

export interface PlaybackConfiguration {
  charsPerSecond?: number
  maxLagChars?: number
  tuning?: Partial<StreamDebugTuning>
}

export interface SessionPlaybackOptions extends PlaybackConfiguration {
  requestFrame?: (callback: (time: number) => void) => number
  cancelFrame?: (handle: number) => void
  now?: () => number
}

interface SegmentState {
  generation: string | number | undefined
  animate: boolean
  text: string
  points: string[]
  displayText: string
  consumed: number
  sealed: boolean
  hidden: boolean
  entered: boolean
  entryBaseline: boolean
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
  private tuning: StreamDebugTuning = { ...DEFAULT_STREAM_DEBUG_TUNING }
  private readonly owners = new Map<string, Map<string, PlaybackSegment>>()
  private readonly states = new Map<string, SegmentState>()
  private readonly active = new Map<string, PlaybackSegment>()
  private ordered: PlaybackSegment[] = []
  private readonly dirtyDisplays = new Set<string>()
  private readonly displays = new Map<string, PlaybackDisplay>()
  private readonly listeners = new Set<() => void>()
  private enabled = true
  private disposed = false
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
    const reopened = new Set<string>()
    for (const source of segments) {
      const previous = this.states.get(source.id)
      const wasActive = this.active.has(source.id)
      const wasComplete = previous !== undefined && this.isComplete(previous)
      const segment: PlaybackSegment = {
        id: source.id,
        order: [...source.order],
        text: source.text,
        sealed: source.sealed,
        hidden: source.hidden === true,
        awaitPresentation: source.awaitPresentation === true,
        ...(source.generation === undefined ? {} : { generation: source.generation }),
        ...(source.baselineChars === undefined ? {} : { baselineChars: source.baselineChars }),
      }
      next.set(segment.id, segment)
      this.updateState(segment, animate)
      const updated = this.states.get(segment.id)!
      if ((!wasActive || wasComplete) && !this.isComplete(updated)) reopened.add(segment.id)
    }
    this.owners.set(owner, next)
    this.rebuildActive()
    this.rehideSuccessors(reopened)
    if (!this.enabled) this.adoptAll()
    else this.queuePump()
    this.trimLedger()
  }

  /** Only an entered source in the same generation can release its presentation barrier. */
  acknowledgePresentation(id: string, generation?: string | number): void {
    if (this.disposed || !this.active.has(id)) return
    const state = this.states.get(id)
    if (!state?.entered || !state.presentationPending || state.generation !== generation) return
    this.clearPresentation(id, state)
    this.queuePump()
  }

  remove(owner: string): void {
    if (this.disposed || !this.owners.delete(owner)) return
    this.rebuildActive()
    this.queuePump()
    this.trimLedger()
  }

  /** Runtime configuration preserves each source's current reveal position. */
  configure(configuration: PlaybackConfiguration): void {
    if (this.disposed || !this.applyConfiguration(configuration)) return
    this.cancelPendingFrame()
    this.resetClock()
    this.queuePump()
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      for (const [id, state] of this.states) this.clearPresentation(id, state)
      this.queuePublish()
    }
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
    for (const segment of this.ordered) {
      const state = this.states.get(segment.id)!
      this.clearPresentation(segment.id, state)
      this.enterState(segment.id, state)
      this.consumeTo(segment.id, state, state.points.length)
      state.fraction = 0
    }
    this.queuePublish()
  }

  /** Catch up in order, but never cross an unsealed protocol boundary. */
  fastForward(): void {
    if (this.disposed) return
    this.cancelPendingFrame()
    this.resetClock()
    for (const segment of this.ordered) {
      const state = this.states.get(segment.id)!
      this.clearPresentation(segment.id, state)
      this.enterState(segment.id, state)
      this.consumeTo(segment.id, state, state.points.length)
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
        animate,
        text: segment.text,
        points: nextPoints,
        displayText: '',
        consumed: 0,
        sealed: segment.sealed,
        hidden: segment.hidden === true,
        entered: false,
        entryBaseline: segment.baselineChars !== undefined,
        presentationPending,
        fraction: 0,
        touched: ++this.touchSequence,
      }
      this.states.set(segment.id, state)
    } else {
      const previousPoints = state.points
      const retry = state.generation !== segment.generation || (state.sealed && !segment.sealed)
      if (retry) {
        this.cancelPendingFrame()
        this.resetClock()
        state.consumed = 0
        state.displayText = ''
        state.entered = false
        state.presentationPending = presentationPending
        state.fraction = 0
      } else if (state.text !== segment.text) {
        if (startsWith(nextPoints, previousPoints)) {
          state.consumed = Math.min(state.consumed, previousPoints.length)
        } else if (state.sealed && state.consumed >= previousPoints.length) {
          // A replacement of completed history is adopted without replaying it.
          state.consumed = nextPoints.length
          state.displayText = state.entered ? segment.text : ''
        } else {
          state.consumed = 0
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
      state.entryBaseline = segment.baselineChars !== undefined
      state.touched = ++this.touchSequence
    }

    if (!presentationPending) this.clearPresentation(segment.id, state)
    this.applyImmediateState(segment.id, state)
    if (!state.hidden && wasHidden && !state.entered) {
      state.consumed = 0
      state.displayText = ''
      state.fraction = 0
    }
    if (segment.baselineChars !== undefined && Number.isFinite(segment.baselineChars)) {
      const baseline = Math.max(0, Math.min(nextPoints.length, Math.floor(segment.baselineChars)))
      const completeBaseline = baseline === nextPoints.length
      if (baseline > 0 || completeBaseline) {
        // Entry history is already visible. Only its live suffix takes part in
        // the reveal clock, and repeated baselines never roll progress back.
        state.consumed = Math.max(state.consumed, baseline)
        state.entered = true
        state.displayText = nextPoints.slice(0, state.consumed).join('')
        if (completeBaseline) this.clearPresentation(segment.id, state)
      }
    }
    this.dirtyDisplays.add(segment.id)
  }

  private applyImmediateState(id: string, state: SegmentState): void {
    if (!state.animate) {
      state.entered = true
      state.consumed = state.points.length
      state.displayText = state.text
      state.fraction = 0
      this.dirtyDisplays.add(id)
    } else if (state.hidden) {
      state.consumed = state.points.length
      if (state.entered) state.displayText = state.text
      state.fraction = 0
      this.dirtyDisplays.add(id)
    }
  }

  private rehideSuccessors(reopened: ReadonlySet<string>): void {
    if (reopened.size === 0) return
    const index = this.ordered.findIndex(segment => {
      if (!reopened.has(segment.id)) return false
      const state = this.states.get(segment.id)
      return state !== undefined && !this.isComplete(state)
    })
    if (index === -1) return
    for (const segment of this.ordered.slice(index + 1)) {
      const state = this.states.get(segment.id)!
      // A reasoning summary and its body share one source cursor. The preview
      // may be replaced when the native row folds/unfolds; never rewind that
      // body's already visible snapshot while the summary generation changes.
      const summaryBase = [...reopened].find(id => id.endsWith(':summary'))?.slice(0, -':summary'.length)
      if (summaryBase !== undefined && segment.id === summaryBase) continue
      if (!state.entered || state.entryBaseline || !state.animate || !this.isComplete(state)) continue
      // Keep consumed progress: a previously shown successor returns whole as
      // soon as the reopened predecessor drains, without replaying old text.
      state.entered = false
      state.displayText = ''
      this.dirtyDisplays.add(segment.id)
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
  }

  private isComplete(state: SegmentState): boolean {
    return state.entered && state.consumed >= state.points.length && state.sealed
      && !state.presentationPending
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

  private consumeTo(id: string, state: SegmentState, consumed: number): void {
    if (consumed <= state.consumed) return
    const previous = state.consumed
    state.consumed = consumed
    if (state.entered) state.displayText += state.points.slice(previous, consumed).join('')
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
    for (const segment of this.ordered) {
      const state = this.states.get(segment.id)!
      if (this.isComplete(state)) continue
      if (state.hidden) {
        this.enterState(segment.id, state)
        this.consumeTo(segment.id, state, state.points.length)
        if (state.sealed) continue
        break
      }
      if (state.points.length === 0) {
        this.enterState(segment.id, state)
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
    const needsFrame = this.enabled && state !== undefined && !state.hidden
      && state.consumed < state.points.length
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
    if (this.disposed || !this.enabled) return
    const timestamp = this.now()
    const previous = this.lastFrameTime ?? timestamp
    const elapsed = Math.max(0, timestamp - previous)
    this.lastFrameTime = timestamp
    const head = this.firstIncomplete()
    const headState = head ? this.states.get(head.id)! : undefined
    const backlog = headState ? headState.points.length - headState.consumed : 0
    const pressure = 1 + Math.min(1, backlog / this.maxLagChars) * this.tuning.queuePressure
    const cps = Math.min(this.tuning.maxRevealCps, this.charsPerSecond * this.tuning.revealScale * pressure)
    const accumulated = Math.min(this.maxLagChars, this.wholeChars + Math.min(elapsed, 120) * cps / 1000)
    let budget = Math.min(Math.max(1, Math.floor(this.tuning.cadenceClamp)), Math.floor(accumulated))
    // Clamp whole-character debt away, preserving only sub-character cadence.
    this.wholeChars = accumulated % 1

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
        if (state.sealed) {
          index++
          continue
        }
        break
      }
      this.enterState(segment.id, state)
      if (state.points.length === 0) {
        if (this.isComplete(state)) {
          index++
          continue
        }
        break
      }
      if (budget <= 0) break
      const amount = Math.min(budget, state.points.length - state.consumed)
      this.consumeTo(segment.id, state, state.consumed + amount)
      budget -= amount
      if (this.isComplete(state)) {
        index++
        continue
      }
      // An open source remains a protocol barrier even after all current text is visible.
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
