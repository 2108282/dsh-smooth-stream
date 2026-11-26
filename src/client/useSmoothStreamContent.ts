/**
 * Stream-smoothing reveal hook.
 *
 * Buffers the model's chunked text and reveals it at a cadence that tracks
 * the observed arrival rate, so a long reply never dumps whole paragraphs at
 * once and a fast stream never stutters. Port of lobe-ui's smoother: EMA
 * arrival cps + chunk size, backlog pressure, commit-interval widening with
 * tail length, and a flush-speed settle drain once the input idles. The
 * reveal decision is the pure {@link computeRevealStep} for unit tests.
 *
 * `shouldHoldBack` is the performance guard's veto: while it returns true the
 * loop keeps measuring but skips the DOM commit, so an offscreen reply never
 * competes with visible frames when the frame rate is degraded.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DEFAULT_STREAM_DEBUG_TUNING, type StreamDebugTuning, type BackgroundRecovery } from '../settings.ts'
import { debugRuntime } from './debugRuntime.ts'
import { recoveryBudget, useBackgroundRecovery, type RecoveryPosition } from './backgroundRecovery.ts'
import { streamRelay } from './streamRelay.ts'

export type StreamSmoothingPreset = 'realtime' | 'balanced' | 'silky'

export interface StreamSmoothingPresetConfig {
  readonly activeInputWindowMs: number
  readonly defaultCps: number
  readonly emaAlpha: number
  readonly flushCps: number
  readonly largeAppendChars: number
  readonly maxActiveCps: number
  readonly maxCps: number
  readonly maxFlushCps: number
  readonly minCps: number
  readonly settleAfterMs: number
  readonly settleDrainMaxMs: number
  readonly settleDrainMinMs: number
  readonly targetBufferMs: number
}

export const PRESET_CONFIG: Record<StreamSmoothingPreset, StreamSmoothingPresetConfig> = {
  balanced: {
    activeInputWindowMs: 220,
    defaultCps: 110,
    emaAlpha: 0.38,
    flushCps: 260,
    largeAppendChars: 140,
    maxActiveCps: 420,
    maxCps: 320,
    maxFlushCps: 560,
    minCps: 28,
    settleAfterMs: 260,
    settleDrainMaxMs: 380,
    settleDrainMinMs: 100,
    targetBufferMs: 32,
  },
  realtime: {
    activeInputWindowMs: 140,
    defaultCps: 120,
    emaAlpha: 0.45,
    flushCps: 240,
    largeAppendChars: 180,
    maxActiveCps: 480,
    maxCps: 320,
    maxFlushCps: 640,
    minCps: 32,
    settleAfterMs: 200,
    settleDrainMaxMs: 280,
    settleDrainMinMs: 100,
    targetBufferMs: 24,
  },
  silky: {
    activeInputWindowMs: 280,
    defaultCps: 64,
    emaAlpha: 0.28,
    flushCps: 140,
    largeAppendChars: 100,
    maxActiveCps: 280,
    maxCps: 180,
    maxFlushCps: 400,
    minCps: 20,
    settleAfterMs: 360,
    settleDrainMaxMs: 520,
    settleDrainMinMs: 160,
    targetBufferMs: 56,
  },
}

/** Pressure curve from the reference stream renderer. */
export const QUEUE_BASE_SPEED_CPS = 90
export const QUEUE_ACCEL_EXPONENT = 1.25
export const QUEUE_PRESSURE_FACTOR = 0.85
export const QUEUE_MAX_SPEED_CPS = 600
/** Hard cap on how far display may trail a live stream, in characters. */
export const LIVE_LAG_CHAR_CEILING = 32
const CATCHUP_SECONDS = 0.15

export const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value))
}

/**
 * Reference pressure-buffer reveal for a frame that starts without debt.
 * @param backlog - Unrevealed characters.
 * @param dtMs - Frame delta in ms.
 * @returns Characters to reveal this frame.
 */
export function computeQueueReveal(backlog: number, dtMs: number): number {
  if (backlog <= 0 || dtMs <= 0) return 0
  return computeAdaptiveQueueStep(backlog, dtMs, 0).revealChars
}

export interface AdaptiveQueueStep {
  readonly revealChars: number
  readonly debt: number
  readonly speedCps: number
}

/** Float-debt queue integration from `ultimate_stream_physics_scroller.html`. */
export function computeAdaptiveQueueStep(
  backlog: number,
  dtMs: number,
  debt: number,
  revealScale = 1,
  tuning: StreamDebugTuning = DEFAULT_STREAM_DEBUG_TUNING,
  retainDebt = false,
): AdaptiveQueueStep {
  if (backlog <= 0 || dtMs <= 0) return { revealChars: 0, debt: 0, speedCps: 0 }
  const speedCps = Math.min(
    tuning.maxRevealCps,
    QUEUE_BASE_SPEED_CPS + Math.pow(backlog, QUEUE_ACCEL_EXPONENT) * tuning.queuePressure,
  )
  const effectiveScale = clamp(revealScale * tuning.revealScale, 0.05, 2)
  // Limit the budget BEFORE applying backpressure. Scaling an already
  // saturated reveal after accumulating unlimited tokens makes a 0.55 scale
  // run at the same cadence as 1, then leaves a burst waiting when it clears.
  // Only sub-character credit carries to the next frame; discarded whole
  // tokens cannot become delayed catch-up debt after a slow frame.
  const maxClamp = Math.max(1, Math.floor(tuning.cadenceClamp ?? 4))
  const fractionalDebt = Math.max(0, debt) % 1
  const frameBudget = Math.min(maxClamp, speedCps * (dtMs / 1000)) * effectiveScale
  const accumulated = fractionalDebt + frameBudget
  const wholeBudget = Math.floor(accumulated)
  const revealChars = Math.min(backlog, maxClamp, wholeBudget)
  return { revealChars, debt: revealChars >= backlog && !retainDebt ? 0 : accumulated - wholeBudget, speedCps }
}

/** Counts user-perceived characters (code points), not UTF-16 units. */
export const countChars = (text: string): number => {
  let count = 0
  for (const char of text) {
    void char
    count += 1
  }
  return count
}

/**
 * Drain rate for backlog beyond the tail-lag ceiling: the displayed text may
 * trail the stream by at most `backlogCharCeiling` characters for at most
 * `backlogSecondCeiling` seconds. The constants are a smoothness invariant
 * (bounded lag is the reason the reveal never stalls mid-reply), so they are
 * not config fields; the preset multiplier is how a deployment tunes them.
 */
export const BACKLOG_CHAR_CEILING = 300
export const BACKLOG_SECOND_CEILING = 2
/** Recovery-only threshold for suppressing automatic reasoning disclosure. */
export const LARGE_RECOVERY_BACKLOG_CHARS = 1200

export interface SettleDrainInput {
  readonly backlog: number
  readonly inputActive: boolean
  readonly settling: boolean
}

/** Pure settle-drain decision shared by the frame loop and its tests. */
export function computeSettleDrain(config: StreamSmoothingPresetConfig, input: SettleDrainInput): number {
  if (input.inputActive || !input.settling) return 0
  // A settled stream must drain fast enough to finish the reply promptly:
  // lag beyond the ceiling drains within the second ceiling.
  const overflow = Math.max(0, input.backlog - BACKLOG_CHAR_CEILING)
  const overflowCps = (overflow * 1000) / BACKLOG_SECOND_CEILING
  const drainTargetMs = clamp(input.backlog * 8, config.settleDrainMinMs, config.settleDrainMaxMs)
  const settleCps = (input.backlog * 1000) / drainTargetMs
  return clamp(Math.max(settleCps, overflowCps), config.flushCps, config.maxFlushCps)
}

/**
 * Fixed velocity that closes a producer-complete queue within its deadline.
 * This completion-only target may exceed the live-stream flush ceiling.
 */
export function computeCompletionDrain(
  config: StreamSmoothingPresetConfig,
  backlog: number,
  initialCps = 0,
): number {
  if (backlog <= 0) return 0
  const drainTargetMs = clamp(backlog * 8, config.settleDrainMinMs, config.settleDrainMaxMs)
  const deadlineSeconds = drainTargetMs / 1000
  const rampAreaSeconds = SETTLE_RAMP_TAU_S * (1 - Math.exp(
    -deadlineSeconds / SETTLE_RAMP_TAU_S,
  ))
  const deadlineCps = (
    backlog - Math.max(0, initialCps) * rampAreaSeconds
  ) / Math.max(0.001, deadlineSeconds - rampAreaSeconds)
  return Math.max(
    deadlineCps,
    computeSettleDrain(config, { backlog, inputActive: false, settling: true }),
  )
}

/**
 * Drain rate multiplier once the input ends: leftover backlog reveals at
 * this multiple of the steady rate, so the end never drags.
 */
export const SETTLE_DRAIN_MULTIPLIER = 1.8
/** Time constant for ramping the completion-drain velocity up from streaming pace. */
export const SETTLE_RAMP_TAU_S = 0.09

export interface RevealStepInput {
  readonly backlog: number
  readonly chunkSizeEma: number
  readonly arrivalCpsEma: number
  readonly emaCps: number
  readonly inputActive: boolean
  readonly settling: boolean
  /** Fixed reveal rate; overrides the arrival-tracking cadence entirely. */
  readonly steadyCps?: number | undefined
}

export interface RevealStepResult {
  readonly revealChars: number
  readonly targetLagChars: number
}

/** Pure per-frame reveal decision shared by the loop and its tests. */
export function computeRevealStep(config: StreamSmoothingPresetConfig, input: RevealStepInput, dtSeconds: number): RevealStepResult {
  // Track the faster of the two EMAs and do not clamp to the old low maxCps
  // ceiling — that cap is why a fast model left hundreds of chars unrevealed.
  const trackedCps = Math.max(input.emaCps, input.arrivalCpsEma)
  const baseCps = clamp(trackedCps, config.minCps, config.maxFlushCps)
  const targetLagChars = input.inputActive
    ? Math.max(2, Math.round((baseCps * config.targetBufferMs) / 1000))
    : 0

  let currentCps: number
  if (input.steadyCps !== undefined) {
    currentCps = input.inputActive || input.settling
      ? clamp(
        input.steadyCps * (input.inputActive ? 1 : SETTLE_DRAIN_MULTIPLIER),
        config.minCps,
        config.maxFlushCps,
      )
      : 0
  } else if (input.inputActive) {
    const overflow = Math.max(0, input.backlog - LIVE_LAG_CHAR_CEILING)
    const catchup = overflow > 0 ? overflow / CATCHUP_SECONDS : 0
    currentCps = clamp(baseCps * 1.08 + catchup, config.minCps, config.maxFlushCps)
  } else if (input.settling) {
    currentCps = computeSettleDrain(config, input)
  } else {
    const idleFlushCps = Math.max(config.flushCps, baseCps * 1.8, input.arrivalCpsEma * 0.8)
    currentCps = clamp(idleFlushCps, config.flushCps, config.maxFlushCps)
  }

  const minRevealChars = input.inputActive ? 1 : 2
  return { revealChars: Math.max(minRevealChars, Math.round(currentCps * dtSeconds)), targetLagChars }
}

export interface UseSmoothStreamContentOptions {
  enabled?: boolean
  /** Requeue the current snapshot when smoothing transitions from disabled to enabled. */
  replayOnEnable?: boolean
  backgroundRecovery?: BackgroundRecovery | undefined
  /** Conversation relay scope for recovery inheritance. */
  recoveryKey?: string | undefined
  /** Position within the recovery scope's ordered output. */
  recoveryPosition?: RecoveryPosition | undefined
  /** Latches large recovery backlogs until their pending text has drained. */
  onRecoveryBacklogChange?: ((pending: boolean) => void) | undefined
  /** Recovery batch selected when this seat mounts during an existing recovery. */
  initialRecoveryEpoch?: number | undefined
  /** Ordered recovery generation: incoming text waits in the next frozen batch. */
  onRecoveryBatchChange?: ((epoch: number | undefined) => void) | undefined
  /** Restore only a previously committed source prefix on renderer remount. */
  initialDisplayedContent?: string | undefined
  /** Apply the selected recovery policy to newly accumulated remount backlog. */
  resumeOnMount?: boolean | undefined
  /** Code-point ranges belonging to collapsed details; synchronize without reveal debt. */
  skipRanges?: readonly (readonly [start: number, end: number])[] | undefined
  /** Recheck live disclosure visibility before applying a potentially stale collapsed range. */
  canSkipRange?: ((start: number, end: number) => boolean) | undefined
  /** The producer has completed; drain queued text without live backpressure. */
  inputComplete?: boolean
  preset?: StreamSmoothingPreset
  /** Performance guard veto: while true, reveal commits are held back. */
  shouldHoldBack?: (() => boolean) | undefined
  /**
   * Fixed reveal rate in chars/s. When set, the reveal runs at this steady
   * pace while the input streams (instead of tracking the arrival rate) and
   * drains an inferred idle backlog at {@link SETTLE_DRAIN_MULTIPLIER}.
   * Explicit producer completion still uses the bounded completion drain.
   */
  steadyCps?: number | undefined
  /**
   * Seed for the arrival-rate EMA. When omitted, the preset's `defaultCps`
   * is used. The live rate then tracks observed arrival; this is not a cap.
   */
  defaultCps?: number | undefined
  /** Written each commit with the live arrival-rate EMA for the follow lerp. */
  speedCpsRef?: { current: number } | undefined
  /** Cumulative code points that have actually committed to the display. */
  revealedCharsRef?: { current: number } | undefined
  /**
   * Called synchronously after each reveal commit lands in the DOM, so the
   * conversation follower can re-run its geometry inside the same task and
   * no intermediate (grown-but-uncompensated) frame can reach a paint.
   */
  onRevealCommit?: (() => void) | undefined
  /** Live multiplier from the follow spring when safe visual lag is filling. */
  revealScaleRef?: { current: number } | undefined
}

/**
 * Smooth a chunked content stream into a reveal-paced display string.
 *
 * @param content - The full accumulated input so far.
 * @param options - Preset, guard, and steady-rate wiring.
 * @returns The displayed content, revealed at the smoothed cadence.
 */
export function useSmoothStreamContent(
  content: string,
  {
    enabled = true,
    replayOnEnable = false,
    backgroundRecovery = 'catch-up',
    recoveryKey,
    recoveryPosition,
    onRecoveryBacklogChange,
    initialRecoveryEpoch,
    onRecoveryBatchChange,
    initialDisplayedContent,
    resumeOnMount = false,
    skipRanges,
    canSkipRange,
    inputComplete = false,
    preset = 'balanced',
    shouldHoldBack,
    steadyCps,
    defaultCps,
    speedCpsRef,
    revealedCharsRef,
    revealScaleRef,
    onRevealCommit,
  }: UseSmoothStreamContentOptions = {},
): string {
  const config = PRESET_CONFIG[preset]
  const seedCps = defaultCps ?? config.defaultCps
  // A fast provider can fill the first Host render with a large batch. Start
  // an enabled stream behind that batch so it still enters the reveal queue;
  // disabled (settled/history) content must remain immediate.
  const [initial] = useState(() => {
    const text = enabled
      ? initialDisplayedContent !== undefined && content.startsWith(initialDisplayedContent) ? initialDisplayedContent : ''
      : content
    const chars = [...text]
    return { text, chars, count: chars.length }
  })
  const [displayedContent, setDisplayedContent] = useState(initial.text)

  const displayedContentRef = useRef(initial.text)
  const displayedCountRef = useRef(initial.count)
  const targetContentRef = useRef(initial.text)
  const targetCharsRef = useRef(initial.chars)
  const targetCountRef = useRef(initial.count)
  const replacementPendingRef = useRef(false)
  const previousEnabledRef = useRef(enabled)

  const emaCpsRef = useRef(seedCps)
  const lastInputTsRef = useRef(0)
  const lastInputCountRef = useRef(initial.count)
  const chunkSizeEmaRef = useRef(1)
  const arrivalCpsEmaRef = useRef(seedCps)

  const rafRef = useRef<number | null>(null)
  const lastFrameTsRef = useRef<number | null>(null)
  const queueDebtRef = useRef(0)
  const settleCpsRef = useRef<number | null>(null)
  const lastDrainCpsRef = useRef(0)
  const holdBackRef = useRef(shouldHoldBack)
  const skipRangesRef = useRef(skipRanges)
  skipRangesRef.current = skipRanges
  const canSkipRangeRef = useRef(canSkipRange)
  canSkipRangeRef.current = canSkipRange
  // A collapsed range is hidden text: it is never printed and must never be
  // counted as pending visible backlog. Ranges the cursor has already passed
  // are excluded by the cursor arithmetic itself, so only ranges still ahead
  // (or straddling the cursor) are subtracted here. A range whose guard says
  // it is not really hidden is real text and stays counted.
  const visibleBacklog = useCallback((displayed: number, target: number): number => {
    let hidden = 0
    for (const [start, end] of skipRangesRef.current ?? []) {
      if (end <= displayed) continue
      if (canSkipRangeRef.current?.(start, end) === false) continue
      const from = Math.max(start, displayed)
      const to = Math.min(target, end)
      if (to > from) hidden += to - from
    }
    return Math.max(0, target - displayed - hidden)
  }, [])
  const recoveryBacklogRef = useRef(false)
  const onRecoveryBacklogChangeRef = useRef(onRecoveryBacklogChange)
  onRecoveryBacklogChangeRef.current = onRecoveryBacklogChange
  const speedOutRef = useRef(speedCpsRef)
  speedOutRef.current = speedCpsRef
  const revealedCharsOutRef = useRef(revealedCharsRef)
  revealedCharsOutRef.current = revealedCharsRef
  const revealScaleOutRef = useRef(revealScaleRef)
  revealScaleOutRef.current = revealScaleRef
  const onRevealCommitOutRef = useRef(onRevealCommit)
  onRevealCommitOutRef.current = onRevealCommit
  const inputCompleteRef = useRef(inputComplete)
  inputCompleteRef.current = inputComplete
  const streamIdRef = useRef(`stream-${Math.random().toString(36).slice(2)}`)
  // Two logical buffers share the authoritative source and one display cursor.
  // The active end is immutable; everything beyond it belongs to the receiving
  // buffer until the cursor reaches that end and the buffers exchange roles.
  const recoveryBatchRef = useRef<{ end: number; epoch: number } | null>(null)
  const initialRecoveryEpochRef = useRef(initialRecoveryEpoch)
  const recoveryBatchCallbackRef = useRef(onRecoveryBatchChange)
  recoveryBatchCallbackRef.current = onRecoveryBatchChange
  const recoveryKeyRef = useRef(recoveryKey)
  recoveryKeyRef.current = recoveryKey
  const clearRecoveryBatch = useCallback(() => {
    if (recoveryBatchRef.current === null) return
    recoveryBatchRef.current = null
    recoveryBatchCallbackRef.current?.(undefined)
  }, [])
  const freezeRecoveryBatch = useCallback((end: number, nextEpoch?: number) => {
    const epoch = nextEpoch ?? initialRecoveryEpochRef.current ?? streamRelay.recoveryEpoch(recoveryKeyRef.current ?? '') ?? 0
    initialRecoveryEpochRef.current = undefined
    recoveryBatchRef.current = { end, epoch }
    recoveryBatchCallbackRef.current?.(epoch)
  }, [])

  useEffect(() => {
    holdBackRef.current = shouldHoldBack
  }, [shouldHoldBack])

  const stopFrameLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    lastFrameTsRef.current = null
  }, [])

  const reportRecoveryBacklog = useCallback((pending: boolean) => {
    if (recoveryBacklogRef.current === pending) return
    recoveryBacklogRef.current = pending
    onRecoveryBacklogChangeRef.current?.(pending)
  }, [])

  const observeRecoveryBacklog = useCallback((backlog: number) => {
    if (backlog > LARGE_RECOVERY_BACKLOG_CHARS) reportRecoveryBacklog(true)
    else if (backlog <= 0) reportRecoveryBacklog(false)
  }, [reportRecoveryBacklog])

  const startFrameLoopRef = useRef<() => void>(() => {})
  const recovery = useBackgroundRecovery(backgroundRecovery, () => {
    clearRecoveryBatch()
    stopFrameLoop()
  }, () => {
    // A synchronization acknowledgement can wake an already playing batch.
    // It must not move its frozen end or reset its fractional reveal budget.
    if (recoveryBatchRef.current === null) {
      queueDebtRef.current = 0
      settleCpsRef.current = null
      lastDrainCpsRef.current = 0
      lastFrameTsRef.current = null
      if (targetCountRef.current > displayedCountRef.current) {
        freezeRecoveryBatch(targetCountRef.current)
      }
    }
    observeRecoveryBacklog(visibleBacklog(
      replacementPendingRef.current ? 0 : displayedCountRef.current,
      targetCountRef.current,
    ))
    startFrameLoopRef.current()
  }, enabled && (!inputComplete || content !== displayedContent) ? recoveryKey : undefined, recoveryPosition, resumeOnMount,
  enabled && (!inputComplete || content !== displayedContent))
  const recoveryRef = useRef(recovery)
  recoveryRef.current = recovery

  const syncImmediate = useCallback(
    (nextContent: string) => {
      stopFrameLoop()
      clearRecoveryBatch()
      replacementPendingRef.current = false
      const chars = [...nextContent]
      const now = performance.now()
      targetContentRef.current = nextContent
      targetCharsRef.current = chars
      targetCountRef.current = chars.length
      displayedContentRef.current = nextContent
      displayedCountRef.current = chars.length
      queueDebtRef.current = 0
      settleCpsRef.current = null
      lastDrainCpsRef.current = 0
      const speedOut = speedOutRef.current
      if (speedOut !== undefined) speedOut.current = seedCps
      setDisplayedContent(nextContent)
      emaCpsRef.current = seedCps
      chunkSizeEmaRef.current = 1
      arrivalCpsEmaRef.current = seedCps
      lastInputTsRef.current = now
      lastInputCountRef.current = chars.length
      reportRecoveryBacklog(false)
    },
    [clearRecoveryBatch, reportRecoveryBacklog, seedCps, stopFrameLoop],
  )

  // Producer completion used to publish the accumulated source in one commit
  // here. That single commit is a visible teleport whenever a fast stream
  // ends with standing backlog — hundreds of chars become thousands of px in
  // one frame, exactly the end-of-render jerk this plugin fights. The frame
  // loop's producer-complete branch already drains the queue at a bounded
  // constant velocity (computeCompletionDrain), which finishes near its
  // configured deadline and glides every px through the spring. Nothing is left
  // "typing" after the Agent stops; the tail just closes at drain speed.
  //
  // Unguarded non-append edits and disabled streams can still sync immediately below.

  const startFrameLoop = useCallback(() => {
    if (rafRef.current !== null || recoveryRef.current.hidden()) return

    const tick = (now: number) => {
      const frameStartedAt = performance.now()
      if (recoveryRef.current.hidden()) { stopFrameLoop(); return }
      if (replacementPendingRef.current) {
        if (holdBackRef.current?.() === true) {
          lastFrameTsRef.current = null
          debugRuntime.recordDiagnosticFrame(`${streamIdRef.current}:text`, now, performance.now() - frameStartedAt)
          rafRef.current = requestAnimationFrame(tick)
          return
        }
        replacementPendingRef.current = false
        displayedContentRef.current = ''
        displayedCountRef.current = 0
        setDisplayedContent('')
      }
      const sourceCount = targetCountRef.current
      const playback = recoveryRef.current
      if (!playback.recovering()) clearRecoveryBatch()
      if (playback.recovering() && playback.mode() !== 'latest' && recoveryBatchRef.current === null
        && sourceCount > displayedCountRef.current) freezeRecoveryBatch(sourceCount)
      const targetCount = Math.min(sourceCount, recoveryBatchRef.current?.end ?? sourceCount)
      let displayedCount = displayedCountRef.current
      // Skip only collapsed source ranges at the current ordered cursor. Visible
      // text before/after them still consumes its own normal reveal budget.
      if (holdBackRef.current?.() !== true) {
        for (const [start, end] of skipRangesRef.current ?? []) {
          if (start > displayedCount) break
          if (canSkipRangeRef.current?.(start, end) === false) continue
          displayedCount = Math.max(displayedCount, Math.min(targetCount, end))
        }
        if (displayedCount !== displayedCountRef.current) {
          const shown = targetCharsRef.current.slice(0, displayedCount).join('')
          displayedContentRef.current = shown
          displayedCountRef.current = displayedCount
          queueDebtRef.current = 0
          setDisplayedContent(shown)
        }
      }
      const backlog = targetCount - displayedCount
      // Drain must be decided by visible text only. A collapsed reasoning block
      // that has not been reached by the cursor yet is hidden, not pending, so
      // fast-forwarding it later must not be the thing that ends recovery.
      const drainBacklog = visibleBacklog(displayedCount, targetCount)
      debugRuntime.recordDiagnostic('text-queue', {
        backlogChars: sourceCount - displayedCount,
        activeBatchChars: recoveryBatchRef.current === null ? undefined : backlog,
        incomingBatchChars: recoveryBatchRef.current === null ? undefined : sourceCount - targetCount,
        recoveryEpoch: recoveryBatchRef.current?.epoch,
        mode: 'assistant',
      })

      if (drainBacklog <= 0) {
        // Invisible ranges can exhaust A before its numeric cursor reaches its
        // end. Keep later visible input in B instead of stopping the only RAF.
        const batch = recoveryBatchRef.current
        if (batch !== null && sourceCount > targetCount) {
          if (visibleBacklog(displayedCount, sourceCount) > 0) {
            freezeRecoveryBatch(sourceCount, batch.epoch + 1)
            rafRef.current = requestAnimationFrame(tick)
            return
          }
          // The receiving buffer contains only collapsed source. Adopt it
          // without inventing an invisible playback batch.
          displayedContentRef.current = targetContentRef.current
          displayedCountRef.current = sourceCount
          setDisplayedContent(targetContentRef.current)
        }
        clearRecoveryBatch()
        reportRecoveryBacklog(false)
        recoveryRef.current.finish()
        queueDebtRef.current = 0
        settleCpsRef.current = null
        const speedOut = speedOutRef.current
        if (speedOut !== undefined) speedOut.current = seedCps
        debugRuntime.recordDiagnosticFrame(`${streamIdRef.current}:text`, now, performance.now() - frameStartedAt)
        debugRuntime.recordDiagnostic('text-queue', { backlogChars: 0, mode: 'drained' })
        debugRuntime.recordDiagnosticFrame(`${streamIdRef.current}:text`, now, performance.now() - frameStartedAt)
        debugRuntime.recordDiagnostic('text-queue', { backlogChars: 0, mode: 'drained' })
        debugRuntime.reportStream(streamIdRef.current, null)
        stopFrameLoop()
        return
      }

      if (lastFrameTsRef.current === null) {
        lastFrameTsRef.current = now
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      const frameIntervalMs = Math.max(0, now - lastFrameTsRef.current)
      debugRuntime.recordDiagnosticFrame(`${streamIdRef.current}:text`, now, performance.now() - frameStartedAt)
      playback.detectGap(frameIntervalMs)
      const recovering = playback.recovering()
      if (recovering && playback.mode() !== 'latest' && recoveryBatchRef.current === null) freezeRecoveryBatch(sourceCount)
      if (playback.resumed()) observeRecoveryBacklog(visibleBacklog(displayedCount, sourceCount))
      const recoveryMode = playback.mode()
      // A latest snapshot is still ordered behind its predecessor; only its
      // character animation is skipped, never the conversation relay.
      if (recovering && recoveryMode === 'latest' && holdBackRef.current?.() !== true) {
        syncImmediate(targetContentRef.current)
        playback.finish()
        return
      }
      const dtSeconds = Math.max(0.001, Math.min(frameIntervalMs / 1000, 0.12))
      lastFrameTsRef.current = now

      const idleMs = now - lastInputTsRef.current
      const producerComplete = inputCompleteRef.current
      const debugTuning = debugRuntime.activeTuning()
      const inputActive = !producerComplete && idleMs <= config.activeInputWindowMs
      const settling = producerComplete || (!inputActive && idleMs >= config.settleAfterMs)
      if (!producerComplete) settleCpsRef.current = null

      let revealChars: number
      let revealSpeedCps: number
      let nextQueueDebt = 0
      if (recovering && recoveryMode === 'catch-up') {
        const step = recoveryBudget(backlog, frameIntervalMs, queueDebtRef.current, debugTuning, true)
        revealChars = step.chars
        nextQueueDebt = step.debt
        revealSpeedCps = revealChars * 1000 / Math.max(1, frameIntervalMs)
      } else if (recovering) {
        const step = computeAdaptiveQueueStep(backlog, Math.min(frameIntervalMs, 32), queueDebtRef.current,
          revealScaleOutRef.current?.current ?? 1, debugTuning, true)
        revealChars = step.revealChars
        revealSpeedCps = step.speedCps
        nextQueueDebt = step.debt
      } else if (producerComplete) {
        // Backpressure protects live layout. Once input has ended, retaining
        // that scale only makes a completed response keep typing onscreen.
        // Keep one TARGET velocity for the whole completion tail — recomputing
        // it from the shrinking backlog creates an exponential slow tail —
        // but RAMP the effective velocity up from the last reveal speed over
        // ~3 frames: an instant jump from streaming pace to max flush is
        // itself a visible jerk at exactly the moment the reader is watching
        // the reply finish.
        // The pre-drain reveal speed is the streaming EMA, not the debug seed.
        // Seeding the ramp from the 35cps default when the reply ran at the
        // max-flush ceiling stretched a 420ms tail past the 800ms announcer
        // step and the visible Markdown mutated across it.
        const previousCps = lastDrainCpsRef.current > 0
          ? lastDrainCpsRef.current
          : Math.max(config.minCps, emaCpsRef.current)
        const drainTargetCps = settleCpsRef.current
          ?? computeCompletionDrain(config, backlog, previousCps)
        settleCpsRef.current = drainTargetCps
        const rampedCps = previousCps
          + (drainTargetCps - previousCps) * (1 - Math.exp(-dtSeconds / SETTLE_RAMP_TAU_S))
        const settleCps = Math.min(drainTargetCps, Math.max(previousCps, rampedCps))
        lastDrainCpsRef.current = Math.min(drainTargetCps, rampedCps)
        const accumulated = Math.max(0, queueDebtRef.current) + settleCps * dtSeconds
        revealChars = Math.min(backlog, Math.floor(accumulated))
        revealSpeedCps = settleCps
        nextQueueDebt = revealChars >= backlog ? 0 : accumulated - revealChars
        if (revealChars >= backlog) lastDrainCpsRef.current = 0
      } else if (steadyCps !== undefined) {
        const step = computeRevealStep(
          config,
          {
            backlog,
            chunkSizeEma: chunkSizeEmaRef.current,
            arrivalCpsEma: arrivalCpsEmaRef.current,
            emaCps: emaCpsRef.current,
            inputActive,
            settling,
            steadyCps,
          },
          dtSeconds,
        )
        revealChars = Math.min(Math.round(step.revealChars * debugTuning.revealScale), backlog)
        revealSpeedCps = frameIntervalMs > 0 ? (revealChars * 1000) / frameIntervalMs : 0
      } else {
        const step = computeAdaptiveQueueStep(
          backlog,
          frameIntervalMs,
          queueDebtRef.current,
          revealScaleOutRef.current?.current ?? 1,
          debugTuning,
        )
        revealChars = step.revealChars
        revealSpeedCps = step.speedCps
        nextQueueDebt = step.debt
      }

      debugRuntime.reportStream(streamIdRef.current, {
        backlog: sourceCount - displayedCount,
        speedCps: revealSpeedCps,
        targetChars: sourceCount,
        displayedChars: displayedCount,
        active: !producerComplete,
      })

      // Performance guard: while degraded and the reply is offscreen, skip
      // the DOM commit — the backlog keeps accumulating and flushes when the
      // guard clears or the reply scrolls into view.
      if (holdBackRef.current?.() === true) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      queueDebtRef.current = nextQueueDebt

      const speedOut = speedOutRef.current
      if (speedOut !== undefined) speedOut.current = revealSpeedCps

      if (revealChars <= 0) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      const nextCount = displayedCount + revealChars
      const segment = targetCharsRef.current.slice(displayedCount, nextCount).join('')
      if (segment) {
        const nextDisplayed = displayedContentRef.current + segment
        displayedContentRef.current = nextDisplayed
        displayedCountRef.current = nextCount
        setDisplayedContent(nextDisplayed)
      } else {
        displayedContentRef.current = targetContentRef.current
        displayedCountRef.current = targetCount
        setDisplayedContent(targetContentRef.current)
      }
      if (visibleBacklog(displayedCountRef.current, sourceCount) <= 0) reportRecoveryBacklog(false)
      const batch = recoveryBatchRef.current
      if (batch !== null && displayedCountRef.current >= batch.end && sourceCount > batch.end) {
        freezeRecoveryBatch(sourceCount, batch.epoch + 1)
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [clearRecoveryBatch, config, freezeRecoveryBatch, observeRecoveryBacklog, reportRecoveryBacklog, seedCps, stopFrameLoop, steadyCps, syncImmediate, visibleBacklog])

  // Run AFTER the commit's DOM mutations, before paint: the follower's
  // same-task correction hook.
  useLayoutEffect(() => {
    const revealedCharsOut = revealedCharsOutRef.current
    if (revealedCharsOut !== undefined) revealedCharsOut.current = displayedCountRef.current
    if (displayedContent === '') return
    onRevealCommitOutRef.current?.()
  }, [displayedContent])

  useEffect(() => {
    startFrameLoopRef.current = startFrameLoop
  }, [startFrameLoop])

  useEffect(() => {
    const replay = enabled && !previousEnabledRef.current && replayOnEnable
    previousEnabledRef.current = enabled
    if (!enabled) {
      recoveryRef.current.cancel()
      clearRecoveryBatch()
      // Only an unchanged target can finish draining an existing queue.
      if (content === targetContentRef.current && displayedCountRef.current < targetCountRef.current) {
        startFrameLoop()
        return
      }
      syncImmediate(content)
      return
    }

    if (replay) syncImmediate('')
    const prevTargetContent = targetContentRef.current
    if (content === prevTargetContent) return

    const now = performance.now()
    const appendOnly = content.startsWith(prevTargetContent)

    if (!appendOnly) {
      if (recoveryRef.current.hidden() || holdBackRef.current?.() === true) {
        targetContentRef.current = content
        targetCharsRef.current = [...content]
        targetCountRef.current = targetCharsRef.current.length
        replacementPendingRef.current = true
        if (recoveryBatchRef.current !== null) {
          // A replacement invalidates the old source offsets, unlike append.
          // Keep the epoch reservation but never replay its superseded suffix.
          recoveryBatchRef.current.end = targetCountRef.current
        }
        if (recoveryRef.current.resumed()) observeRecoveryBacklog(visibleBacklog(0, targetCountRef.current))
        startFrameLoop()
        return
      }
      syncImmediate(content)
      return
    }

    const appended = content.slice(prevTargetContent.length)
    const appendedChars = [...appended]
    const appendedCount = appendedChars.length

    targetContentRef.current = content
    targetCharsRef.current.push(...appendedChars)
    targetCountRef.current += appendedCount
    if (recoveryRef.current.recovering() && !recoveryRef.current.hidden() && backgroundRecovery !== 'latest'
      && recoveryBatchRef.current === null) freezeRecoveryBatch(targetCountRef.current)
    if (recoveryBatchRef.current === null) settleCpsRef.current = null

    const hadSample = lastInputTsRef.current > 0
    const deltaChars = targetCountRef.current - lastInputCountRef.current
    const deltaMs = Math.max(1, now - lastInputTsRef.current)

    // Skip the first sample: lastInputTs starts at 0, so the interval would
    // be "time since page load" (or 1ms under fake timers) and poison the EMA.
    if (hadSample && deltaChars > 0) {
      const instantCps = (deltaChars * 1000) / deltaMs
      const normalizedInstantCps = clamp(instantCps, config.minCps, config.maxFlushCps * 3)
      const chunkEmaAlpha = 0.45
      chunkSizeEmaRef.current = chunkSizeEmaRef.current * (1 - chunkEmaAlpha) + appendedCount * chunkEmaAlpha
      arrivalCpsEmaRef.current = arrivalCpsEmaRef.current * (1 - chunkEmaAlpha) + normalizedInstantCps * chunkEmaAlpha
      emaCpsRef.current = emaCpsRef.current * (1 - config.emaAlpha) + normalizedInstantCps * config.emaAlpha
    }

    lastInputTsRef.current = now
    lastInputCountRef.current = targetCountRef.current

    if (recoveryRef.current.resumed()) observeRecoveryBacklog(visibleBacklog(
      replacementPendingRef.current ? 0 : displayedCountRef.current,
      targetCountRef.current,
    ))
    startFrameLoop()
  }, [backgroundRecovery, clearRecoveryBatch, content, enabled, freezeRecoveryBatch, replayOnEnable, config, observeRecoveryBacklog, startFrameLoop, syncImmediate, visibleBacklog])

  useEffect(() => {
    if (enabled && skipRanges !== undefined) startFrameLoop()
  }, [enabled, skipRanges, startFrameLoop])

  useEffect(() => {
    return () => {
      stopFrameLoop()
      debugRuntime.reportStream(streamIdRef.current, null)
    }
  }, [stopFrameLoop])

  return displayedContent
}
