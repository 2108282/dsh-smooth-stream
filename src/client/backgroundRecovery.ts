import { useLayoutEffect, useRef } from 'react'
import type { BackgroundRecovery, StreamDebugTuning } from '../settings.ts'

/** A stalled WebView may not deliver visibility events; only a long frame gap is a fallback. */
export const BACKGROUND_GAP_MS = 1000
export const RECOVERY_COMMIT_MS = 40
export const RECOVERY_MAX_CHARS = 16

export type RecoveryPosition = readonly [step: number, order: number, part: number]
interface RecoveryClient {
  hidden: () => void
  resume: () => void
  key: () => string | undefined
  position: () => RecoveryPosition | undefined
  recovering: () => boolean
}
const clients = new Set<RecoveryClient>()
const recoveryScopes = new Map<string, RecoveryPosition | undefined>()
let attached = false
let background = false

/** A resume batch belongs to its observed turn, not a wall-clock window. */
export function isBackgroundRecoveryScope(key: string, position?: RecoveryPosition): boolean {
  if (!recoveryScopes.has(key)) return false
  const frontier = recoveryScopes.get(key)
  return position === undefined || frontier === undefined || comparePosition(position, frontier) >= 0
}

function comparePosition(left: RecoveryPosition, right: RecoveryPosition): number {
  for (let index = 0; index < left.length; index++) {
    const delta = left[index]! - right[index]!
    if (delta !== 0) return delta
  }
  return 0
}

function rememberScope(key: string | undefined, position?: RecoveryPosition): void {
  if (key === undefined) return
  const previous = recoveryScopes.get(key)
  if (!recoveryScopes.has(key) || previous === undefined || (position !== undefined && comparePosition(position, previous) < 0)) {
    recoveryScopes.set(key, position)
  }
}

function rememberScopes(): void {
  for (const client of clients) rememberScope(client.key(), client.position())
}

function retireScopes(): void {
  for (const key of recoveryScopes.keys()) {
    if (![...clients].some(client => client.key() === key && client.recovering())) recoveryScopes.delete(key)
  }
}

function hide(): void {
  if (background) return
  background = true
  rememberScopes()
  for (const client of [...clients]) client.hidden()
}
function show(): void {
  if (!background) return
  background = false
  rememberScopes()
  for (const client of [...clients]) client.resume()
}
function visibility(): void { if (document.hidden) hide(); else show() }
function focus(): void { if (!document.hidden) show() }
function attach(): void {
  if (attached || typeof document === 'undefined') return
  attached = true
  background = document.hidden
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pagehide', hide)
  window.addEventListener('pageshow', focus)
  // Focus loss alone (dialogs, menus, keyboard) is not a WebView suspension.
  window.addEventListener('focus', focus)
  // Native shells can emit these without forging browser network/visibility state.
  window.addEventListener('dsha:background', hide)
  window.addEventListener('dsha:foreground', show)
}
function detach(): void {
  if (!attached || clients.size !== 0) return
  document.removeEventListener('visibilitychange', visibility)
  window.removeEventListener('pagehide', hide)
  window.removeEventListener('pageshow', focus)
  window.removeEventListener('focus', focus)
  window.removeEventListener('dsha:background', hide)
  window.removeEventListener('dsha:foreground', show)
  attached = false
  background = false
  recoveryScopes.clear()
}

/** Shared lifecycle listeners, per-renderer playback progress and disposal. */
export function useBackgroundRecovery(mode: BackgroundRecovery, onHidden: () => void, onResume: () => void,
  scopeKey?: string, scopePosition?: RecoveryPosition) {
  const keyRef = useRef(scopeKey)
  keyRef.current = scopeKey
  const positionRef = useRef(scopePosition)
  positionRef.current = scopePosition
  const callbacks = useRef({ onHidden, onResume })
  callbacks.current = { onHidden, onResume }
  const state = useRef({ mode, recovering: false, resumed: false, wasHidden: false, awaitingData: false })
  state.current.mode = mode
  useLayoutEffect(() => {
    attach()
    const client: RecoveryClient = {
      key: () => keyRef.current,
      position: () => positionRef.current,
      recovering: () => state.current.recovering || state.current.wasHidden,
      hidden: () => { state.current.wasHidden = true; callbacks.current.onHidden() },
      resume: () => {
        state.current.wasHidden = false
        state.current.recovering = true
        state.current.resumed = true
        state.current.awaitingData = true
        callbacks.current.onResume()
      },
    }
    clients.add(client)
    // Late publications inherit the same turn's recovery until its queues drain.
    // Historical rows in another turn do not inherit a recent foreground event.
    const key = keyRef.current
    state.current.recovering = key !== undefined && isBackgroundRecoveryScope(key, positionRef.current)
    state.current.resumed = state.current.recovering
    state.current.awaitingData = state.current.recovering
    if (background) {
      rememberScope(key, positionRef.current)
      client.hidden()
    }
    return () => { clients.delete(client); retireScopes(); detach() }
  }, [])
  useLayoutEffect(() => {
    // Completion can retire a live seat without another text commit. Removing
    // its key must also release an awaiting-data recovery scope.
    retireScopes()
  }, [scopeKey])
  return {
    hidden: (): boolean => background,
    mode: (): BackgroundRecovery => state.current.mode,
    recovering: (): boolean => state.current.recovering,
    resumed: (): boolean => state.current.resumed,
    cancel: (): void => {
      state.current.recovering = false
      state.current.resumed = false
      state.current.wasHidden = false
      state.current.awaitingData = false
      retireScopes()
    },
    observeBacklog: (pending: boolean): void => { if (pending) state.current.awaitingData = false },
    finish: (): void => {
      if (state.current.awaitingData) return
      state.current.recovering = false
      state.current.resumed = false
      retireScopes()
    },
    detectGap: (elapsed: number): void => {
      if (elapsed >= BACKGROUND_GAP_MS) {
        state.current.recovering = true
        state.current.awaitingData = false
        // A slow foreground frame can trigger bounded playback, but does not
        // count as a WebView foreground transition for disclosure policy.
      }
    },
  }
}

/** Bounded faster budget. At most 25 DOM commits/s, never an unbounded completion drain. */
export function recoveryBudget(backlog: number, elapsedMs: number, debt: number, tuning: StreamDebugTuning) {
  if (elapsedMs < RECOVERY_COMMIT_MS) return { chars: 0, debt }
  const cps = Math.min(400, Math.max(120, tuning.maxRevealCps * tuning.revealScale * 1.5))
  const budget = cps * Math.min(elapsedMs, 80) / 1000 + debt % 1
  const chars = Math.min(backlog, RECOVERY_MAX_CHARS, Math.floor(budget))
  return { chars, debt: chars >= backlog ? 0 : budget % 1 }
}
