/**
 * Shared browser-side diagnostics state.
 *
 * The settings card owns persistence. This module is the live bridge used by
 * the renderer and the chat-side panel: renderer loops publish measurements,
 * while panel edits are staged through the settings-card controller.
 */

import { createSnapshotStore, type SnapshotStore } from './clientStore.ts'
import {
  DEFAULT_STREAM_DEBUG_TUNING,
  type StreamDebugTuning,
  type StreamSettings,
} from '../settings.ts'

export interface DebugMetrics {
  fps: number | null
  frameMs: number | null
  fpsDegraded: boolean
  streamActive: boolean
  streamBacklog: number
  streamSpeedCps: number
  streamTargetChars: number
  streamDisplayedChars: number
  followActive: boolean
  followLagPx: number
  followVelocityPxPerSec: number
  followReservePx: number
  followCapacityPx: number
  followRevealScale: number
  followFollowing: boolean
  followConstrained: boolean
  scrollTop: number | null
  scrollHeight: number | null
  clientHeight: number | null
  lastUpdatedMs: number | null
}

export interface DebugRuntimeState {
  available: boolean
  enabled: boolean
  diagnosticActive: boolean
  tuningEnabled: boolean
  writable: boolean
  dirty: boolean
  status: 'loading' | 'ready' | 'unavailable'
  tuning: StreamDebugTuning
  metrics: DebugMetrics
}

export type DebugSettingsPatch = Partial<Pick<StreamSettings, 'debugEnabled' | 'debugTuningEnabled' | 'debugTuning'>>

export interface DebugPanelFace {
  hooks: {
    debugRuntime: SnapshotStore<DebugRuntimeState>
  }
  edit: (patch: DebugSettingsPatch) => void
  save: () => void
  discard: () => void
  reset: () => void
  startDiagnostics: () => void
  stopDiagnostics: () => DiagnosticCapture | null
}

interface DebugSettingsActions {
  edit: (patch: DebugSettingsPatch) => void
  save: () => void
  discard: () => void
}

interface StreamMetric {
  backlog: number
  speedCps: number
  targetChars: number
  displayedChars: number
  active: boolean
  updatedAt: number
}

export interface DiagnosticCapture {
  readonly startedAtMs: number | null
  readonly durationMs: number
  readonly frameMetric: string
  readonly samples: readonly DiagnosticSample[]
  readonly frames: Readonly<Record<string, unknown>>
  readonly longTasks: Readonly<{ count: number; maxDurationMs: number; over50: number; over100: number; supported: boolean }>
}

export interface DiagnosticSample {
  readonly atMs: number
  readonly kind: 'lifecycle' | 'raf' | 'text-frame' | 'follow-frame' | 'text-queue'
  readonly event?: string
  readonly gapMs?: number
  readonly durationMs?: number
  readonly backlogChars?: number
  readonly pendingNodes?: number
  readonly records?: number
  readonly mode?: string
}

const DIAGNOSTIC_SAMPLE_LIMIT = 240
const DIAGNOSTIC_FRAME_INTERVAL_MS = 100
const DIAGNOSTIC_FRAME_SOURCE_LIMIT = 64
const diagnosticSamples: DiagnosticSample[] = []
const diagnosticLastSampleAt = new Map<string, number>()
const diagnosticLastFrameAt = new Map<string, number>()
const diagnosticFrames = new Map<string, {
  count: number
  over16: number
  over32: number
  over50: number
  over100: number
  over1000: number
  maxGapMs: number
  maxDurationMs: number
}>()
let diagnosticStartedAt: number | null = null
let diagnosticLifecycleCleanup: (() => void) | undefined
let diagnosticLongTaskObserver: PerformanceObserver | undefined
let diagnosticLongTasks = { count: 0, maxDurationMs: 0, over50: 0, over100: 0 }

function pushDiagnostic(sample: DiagnosticSample): void {
  if (diagnosticSamples.length === DIAGNOSTIC_SAMPLE_LIMIT) diagnosticSamples.shift()
  diagnosticSamples.push(sample)
}

interface FollowMetric {
  lagPx: number
  velocityPxPerSec: number
  reservePx: number
  capacityPx: number
  revealScale: number
  following: boolean
  constrained: boolean
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  active: boolean
  updatedAt: number
}

const EMPTY_METRICS: DebugMetrics = {
  fps: null,
  frameMs: null,
  fpsDegraded: false,
  streamActive: false,
  streamBacklog: 0,
  streamSpeedCps: 0,
  streamTargetChars: 0,
  streamDisplayedChars: 0,
  followActive: false,
  followLagPx: 0,
  followVelocityPxPerSec: 0,
  followReservePx: 0,
  followCapacityPx: 0,
  followRevealScale: 1,
  followFollowing: false,
  followConstrained: false,
  scrollTop: null,
  scrollHeight: null,
  clientHeight: null,
  lastUpdatedMs: null,
}

const INITIAL_STATE: DebugRuntimeState = {
  available: false,
  enabled: false,
  diagnosticActive: false,
  tuningEnabled: false,
  writable: false,
  dirty: false,
  status: 'loading',
  tuning: { ...DEFAULT_STREAM_DEBUG_TUNING },
  metrics: EMPTY_METRICS,
}

const store = createSnapshotStore<DebugRuntimeState>(INITIAL_STATE)
const streamMetrics = new Map<string, StreamMetric>()
const followMetrics = new Map<HTMLElement, FollowMetric>()
let actions: DebugSettingsActions | undefined
let lastMetricPublish = 0

function resetMetrics(): void {
  streamMetrics.clear()
  followMetrics.clear()
  lastMetricPublish = 0
}

function resetRuntime(): void {
  if (diagnosticStartedAt !== null) {
    diagnosticLifecycleCleanup?.()
    diagnosticLifecycleCleanup = undefined
    diagnosticStartedAt = null
    diagnosticLastSampleAt.clear()
    diagnosticLastFrameAt.clear()
    diagnosticSamples.length = 0
    diagnosticFrames.clear()
    diagnosticLongTaskObserver?.disconnect()
    diagnosticLongTaskObserver = undefined
    diagnosticLongTasks = { count: 0, maxDurationMs: 0, over50: 0, over100: 0 }
  }
  actions = undefined
  resetMetrics()
  store.set({ ...INITIAL_STATE, metrics: EMPTY_METRICS })
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function sameTuning(left: StreamDebugTuning, right: StreamDebugTuning): boolean {
  return left.revealScale === right.revealScale
    && left.queuePressure === right.queuePressure
    && left.maxRevealCps === right.maxRevealCps
    && left.cadenceClamp === right.cadenceClamp
    && left.springStiffness === right.springStiffness
    && left.springDamping === right.springDamping
    && left.springMass === right.springMass
    && left.runwayPx === right.runwayPx
    && left.reserveResponseMs === right.reserveResponseMs
    && left.backpressureMinScale === right.backpressureMinScale
}

function currentMetrics(timestamp: number): DebugMetrics {
  let stream: StreamMetric | undefined
  for (const candidate of streamMetrics.values()) {
    if (stream === undefined || candidate.updatedAt > stream.updatedAt) stream = candidate
  }
  let follow: FollowMetric | undefined
  for (const candidate of followMetrics.values()) {
    if (follow === undefined || candidate.updatedAt > follow.updatedAt) follow = candidate
  }
  return {
    fps: store.getSnapshot().metrics.fps,
    frameMs: store.getSnapshot().metrics.frameMs,
    fpsDegraded: store.getSnapshot().metrics.fpsDegraded,
    streamActive: stream?.active ?? false,
    streamBacklog: stream?.backlog ?? 0,
    streamSpeedCps: stream?.speedCps ?? 0,
    streamTargetChars: stream?.targetChars ?? 0,
    streamDisplayedChars: stream?.displayedChars ?? 0,
    followActive: follow?.active ?? false,
    followLagPx: follow?.lagPx ?? 0,
    followVelocityPxPerSec: follow?.velocityPxPerSec ?? 0,
    followReservePx: follow?.reservePx ?? 0,
    followCapacityPx: follow?.capacityPx ?? 0,
    followRevealScale: follow?.revealScale ?? 1,
    followFollowing: follow?.following ?? false,
    followConstrained: follow?.constrained ?? false,
    scrollTop: follow?.scrollTop ?? null,
    scrollHeight: follow?.scrollHeight ?? null,
    clientHeight: follow?.clientHeight ?? null,
    lastUpdatedMs: timestamp,
  }
}

function publishMetrics(force = false): void {
  const timestamp = now()
  if (!force && timestamp - lastMetricPublish < 80) return
  lastMetricPublish = timestamp
  store.set({ ...store.getSnapshot(), metrics: currentMetrics(timestamp) })
}

export const debugRuntime = {
  store,

  getSnapshot(): DebugRuntimeState {
    return store.getSnapshot()
  },

  subscribe(listener: () => void): () => void {
    return store.subscribe(listener)
  },

  /** Whether hot-path instrumentation should do any work. */
  isEnabled(): boolean {
    return store.getSnapshot().enabled
  },

  tuning(): StreamDebugTuning {
    return store.getSnapshot().tuning
  },

  /** Saved physical parameters are independent of HUD instrumentation. */
  activeTuning(): StreamDebugTuning {
    return store.getSnapshot().tuningEnabled ? store.getSnapshot().tuning : DEFAULT_STREAM_DEBUG_TUNING
  },

  bindSettings(nextActions: DebugSettingsActions | undefined): () => void {
    actions = nextActions
    return () => {
      if (actions !== nextActions) return
      resetRuntime()
    }
  },

  syncSettings(input: {
    available?: boolean
    enabled: boolean
    tuningEnabled?: boolean
    writable: boolean
    dirty: boolean
    status: DebugRuntimeState['status']
    tuning?: StreamDebugTuning
  }): void {
    const current = store.getSnapshot()
    // Callers predating the Host capability flag are local diagnostics tests
    // and renderer probes; preserve their enabled behavior unless the wiring
    // explicitly reports that the RPC is unavailable.
    const available = input.available ?? true
    const enabled = available && input.enabled
    const tuningEnabled = available && (input.tuningEnabled ?? false)
    const availabilityChanged = current.available !== available
    const enabledChanged = current.enabled !== enabled
    if (availabilityChanged || enabledChanged) resetMetrics()
    const tuning = input.tuning === undefined
      ? current.tuning
      : { ...DEFAULT_STREAM_DEBUG_TUNING, ...input.tuning }
    if (
      current.available === available
      && current.enabled === enabled
      && current.tuningEnabled === tuningEnabled
      && current.writable === input.writable
      && current.dirty === input.dirty
      && current.status === input.status
      && sameTuning(current.tuning, tuning)
    ) return
    store.set({
      ...current,
      available,
      enabled,
      diagnosticActive: diagnosticStartedAt !== null,
      tuningEnabled,
      writable: input.writable,
      dirty: input.dirty,
      status: input.status,
      tuning,
      metrics: availabilityChanged || enabledChanged || !enabled ? EMPTY_METRICS : current.metrics,
    })
  },

  edit(patch: DebugSettingsPatch): void {
    const current = store.getSnapshot()
    const enabled = patch.debugEnabled ?? current.enabled
    const tuningEnabled = patch.debugTuningEnabled ?? current.tuningEnabled
    const enabledChanged = current.enabled !== enabled
    if (enabledChanged) resetMetrics()
    const tuning = patch.debugTuning === undefined
      ? current.tuning
      : { ...current.tuning, ...patch.debugTuning }
    store.set({
      ...current,
      enabled,
      tuningEnabled,
      dirty: true,
      diagnosticActive: diagnosticStartedAt !== null,
      tuning,
      metrics: enabledChanged || !enabled ? EMPTY_METRICS : current.metrics,
    })
    actions?.edit({
      ...(patch.debugEnabled === undefined ? {} : { debugEnabled: patch.debugEnabled }),
      ...(patch.debugTuningEnabled === undefined ? {} : { debugTuningEnabled: patch.debugTuningEnabled }),
      ...(patch.debugTuning === undefined ? {} : { debugTuning: tuning }),
    })
  },

  save(): void {
    actions?.save()
  },

  discard(): void {
    actions?.discard()
  },

  reset(): void {
    this.edit({ debugTuning: { ...DEFAULT_STREAM_DEBUG_TUNING } })
  },

  reportStream(id: string, metric: Omit<StreamMetric, 'updatedAt'> | null): void {
    if (!this.isEnabled()) return
    if (metric === null) streamMetrics.delete(id)
    else streamMetrics.set(id, { ...metric, updatedAt: now() })
    publishMetrics(metric === null)
  },

  reportFollow(port: HTMLElement, metric: Omit<FollowMetric, 'updatedAt'> | null): void {
    if (!this.isEnabled()) return
    if (metric === null) followMetrics.delete(port)
    else followMetrics.set(port, { ...metric, updatedAt: now() })
    publishMetrics(metric === null)
  },

  startDiagnostics(): boolean {
    if (diagnosticStartedAt !== null) return false
    diagnosticStartedAt = now()
    store.set({ ...store.getSnapshot(), diagnosticActive: true })
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        diagnosticLongTaskObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            diagnosticLongTasks.count++
            diagnosticLongTasks.maxDurationMs = Math.max(diagnosticLongTasks.maxDurationMs, entry.duration)
            if (entry.duration > 50) diagnosticLongTasks.over50++
            if (entry.duration > 100) diagnosticLongTasks.over100++
          }
        })
        diagnosticLongTaskObserver.observe({ type: 'longtask', buffered: false })
      } catch {
        diagnosticLongTaskObserver = undefined
      }
    }
    if (typeof document !== 'undefined') {
      const onVisibility = () => {
        this.recordDiagnostic('lifecycle', { event: document.hidden ? 'visibility-hidden' : 'visibility-visible' })
      }
      const onBackground = () => { this.recordDiagnostic('lifecycle', { event: 'native-background' }) }
      const onForeground = () => { this.recordDiagnostic('lifecycle', { event: 'native-foreground' }) }
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('dsha:background', onBackground)
      window.addEventListener('dsha:foreground', onForeground)
      diagnosticLifecycleCleanup = () => {
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('dsha:background', onBackground)
        window.removeEventListener('dsha:foreground', onForeground)
      }
    }
    diagnosticLastSampleAt.clear()
    diagnosticLastFrameAt.clear()
    diagnosticSamples.length = 0
    diagnosticFrames.clear()
    diagnosticLongTasks = { count: 0, maxDurationMs: 0, over50: 0, over100: 0 }
    pushDiagnostic({ atMs: 0, kind: 'lifecycle', event: 'capture-start' })
    return true
  },

  stopDiagnostics(): DiagnosticCapture | null {
    if (diagnosticStartedAt === null) return null
    const timestamp = now()
    const startedAtMs = diagnosticStartedAt
    const frames = Object.fromEntries([...diagnosticFrames].map(([name, stats]) => [name, { ...stats }]))
    if (startedAtMs !== null) pushDiagnostic({ atMs: timestamp - startedAtMs, kind: 'lifecycle', event: 'capture-stop' })
    const result = {
      startedAtMs,
      durationMs: startedAtMs === null ? 0 : timestamp - startedAtMs,
      frameMetric: 'requestAnimationFrame callback interval; not display/compositor FPS',
      samples: diagnosticSamples.map(sample => ({ ...sample })),
      frames,
      longTasks: { ...diagnosticLongTasks, supported: typeof PerformanceObserver !== 'undefined' },
    }
    diagnosticLongTaskObserver?.disconnect()
    diagnosticLongTaskObserver = undefined
    diagnosticLongTasks = { count: 0, maxDurationMs: 0, over50: 0, over100: 0 }
    diagnosticLifecycleCleanup?.()
    diagnosticLifecycleCleanup = undefined
    diagnosticStartedAt = null
    store.set({ ...store.getSnapshot(), diagnosticActive: false })
    diagnosticLastSampleAt.clear()
    diagnosticLastFrameAt.clear()
    diagnosticSamples.length = 0
    diagnosticFrames.clear()
    return result
  },

  diagnosticsActive(): boolean {
    return diagnosticStartedAt !== null
  },

  recordDiagnostic(kind: DiagnosticSample['kind'], values: Omit<DiagnosticSample, 'atMs' | 'kind'> = {}): void {
    if (diagnosticStartedAt === null) return
    const timestamp = now()
    const sampleKey = values.event === undefined ? kind : `${kind}:${values.event}`
    const previous = diagnosticLastSampleAt.get(sampleKey) ?? 0
    if (kind !== 'lifecycle' && timestamp - previous < DIAGNOSTIC_FRAME_INTERVAL_MS) return
    diagnosticLastSampleAt.set(sampleKey, timestamp)
    pushDiagnostic({ atMs: timestamp - diagnosticStartedAt, kind, ...values })
  },

  recordDiagnosticFrame(name: string, timestamp: number, durationMs: number): void {
    if (diagnosticStartedAt === null) return
    if (!diagnosticFrames.has(name) && diagnosticFrames.size >= DIAGNOSTIC_FRAME_SOURCE_LIMIT) return
    const previous = diagnosticLastFrameAt.get(name) ?? 0
    diagnosticLastFrameAt.set(name, timestamp)
    const gapMs = previous === 0 ? 0 : Math.max(0, timestamp - previous)
    const stats = diagnosticFrames.get(name) ?? {
      count: 0, over16: 0, over32: 0, over50: 0, over100: 0, over1000: 0,
      maxGapMs: 0, maxDurationMs: 0,
    }
    stats.count++
    if (gapMs > 16) stats.over16++
    if (gapMs > 32) stats.over32++
    if (gapMs > 50) stats.over50++
    if (gapMs > 100) stats.over100++
    if (gapMs > 1000) stats.over1000++
    stats.maxGapMs = Math.max(stats.maxGapMs, gapMs)
    stats.maxDurationMs = Math.max(stats.maxDurationMs, durationMs)
    diagnosticFrames.set(name, stats)
    const lastSample = diagnosticLastSampleAt.get(`frame:${name}`) ?? 0
    if (gapMs > 32 || durationMs > 8 || timestamp - lastSample >= DIAGNOSTIC_FRAME_INTERVAL_MS) {
      diagnosticLastSampleAt.set(`frame:${name}`, timestamp)
      pushDiagnostic({
        atMs: timestamp - diagnosticStartedAt,
        kind: name.startsWith('follow') ? 'follow-frame' : 'text-frame',
        gapMs,
        durationMs,
      })
    }
  },

  reportFps(fps: number, frameMs: number, degraded: boolean): void {
    if (!this.isEnabled()) return
    const current = store.getSnapshot()
    store.set({
      ...current,
      metrics: { ...current.metrics, fps, frameMs, fpsDegraded: degraded, lastUpdatedMs: now() },
    })
  },

  clearFps(): void {
    if (!this.isEnabled()) return
    const current = store.getSnapshot()
    store.set({
      ...current,
      metrics: {
        ...current.metrics,
        fps: null,
        frameMs: null,
        fpsDegraded: false,
        lastUpdatedMs: now(),
      },
    })
  },

  panelFace(): DebugPanelFace {
    return {
      hooks: { debugRuntime: store },
      edit: patch => { this.edit(patch) },
      save: () => { this.save() },
      discard: () => { this.discard() },
      reset: () => { this.reset() },
      startDiagnostics: () => { this.startDiagnostics() },
      stopDiagnostics: () => this.stopDiagnostics(),
    }
  },

  resetRuntime(): void {
    resetRuntime()
  },
}
