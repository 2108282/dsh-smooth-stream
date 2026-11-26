import { useLayoutEffect, useRef } from 'react'
import type { BackgroundRecovery, StreamDebugTuning } from '../settings.ts'
import { debugRuntime } from './debugRuntime.ts'

/** A stalled WebView may not deliver visibility events; only a long frame gap is a fallback. */
export const BACKGROUND_GAP_MS = 1000
export const RECOVERY_MAX_CHARS = 16

export type RecoveryPosition = readonly [step: number, order: number, part: number]
interface RecoveryClient {
  hidden: () => void
  resume: () => void
  key: () => string | undefined
  position: () => RecoveryPosition | undefined
  recovering: () => boolean
  waitingForSync: () => boolean
  synchronized: () => void
}

/** Optional Host synchronization fence; no elapsed timeout can prove a baseline arrived. */
export interface RecoverySynchronization {
  pending(key: string): boolean
}
let synchronization: RecoverySynchronization | undefined
export function installRecoverySynchronization(source: RecoverySynchronization): () => void {
  synchronization = source
  return () => {
    if (synchronization !== source) return
    synchronization = undefined
    notifyRecoverySynchronized()
  }
}
export function notifyRecoverySynchronized(): void {
  if (background) return
  for (const client of [...clients]) {
    const key = client.key()
    if (client.recovering() && client.waitingForSync() && (key === undefined || synchronization?.pending(key) !== true)) client.synchronized()
  }
}
const clients = new Set<RecoveryClient>()
const recoveryScopes = new Map<string, RecoveryPosition | undefined>()
let attached = false
let background = false
let nativeBackground = false
let foregroundDelayMs = 0
let foregroundPending = false
let foregroundTimer: ReturnType<typeof setTimeout> | undefined

/** Set the user-owned delay used only for native dsha:foreground signals. */
export function setForegroundRecoveryDelay(delayMs: number): void {
  foregroundDelayMs = Number.isInteger(delayMs) && delayMs >= 0 ? Math.min(10000, delayMs) : 0
}

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

function hide(native = false): void {
  if (native) nativeBackground = true
  if (background && !foregroundPending) return
  if (foregroundTimer !== undefined) clearTimeout(foregroundTimer)
  foregroundTimer = undefined
  foregroundPending = false
  background = true
  debugRuntime.recordDiagnostic('lifecycle', { event: 'recovery-hidden' })
  rememberScopes()
  for (const client of [...clients]) client.hidden()
}
function show(delayMs = 0, native = false): void {
  if (foregroundPending) return
  if (native) nativeBackground = false
  if (nativeBackground && !native) return
  if (!background && !foregroundPending) return
  if (foregroundTimer !== undefined) clearTimeout(foregroundTimer)
  foregroundTimer = undefined
  foregroundPending = false
  if (delayMs > 0) {
    foregroundPending = true
    foregroundTimer = setTimeout(() => {
      foregroundTimer = undefined
      if (!foregroundPending) return
      foregroundPending = false
      background = false
      debugRuntime.recordDiagnostic('lifecycle', { event: 'recovery-resume' })
      rememberScopes()
      for (const client of [...clients]) client.resume()
    }, delayMs)
    return
  }
  background = false
  debugRuntime.recordDiagnostic('lifecycle', { event: 'recovery-resume' })
  rememberScopes()
  for (const client of [...clients]) client.resume()
}
function visibility(): void { if (document.hidden) hide(); else show() }
function pageHide(): void { hide() }
function focus(): void { if (!document.hidden) show() }
function nativeBackgroundSignal(): void { hide(true) }
function nativeForeground(): void { show(foregroundDelayMs, true) }
function attach(): void {
  if (attached || typeof document === 'undefined') return
  attached = true
  background = document.hidden
  nativeBackground = false
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pagehide', pageHide)
  window.addEventListener('pageshow', focus)
  // Focus loss alone (dialogs, menus, keyboard) is not a WebView suspension.
  window.addEventListener('focus', focus)
  // Native shells can emit these without forging browser network/visibility state.
  window.addEventListener('dsha:background', nativeBackgroundSignal)
  window.addEventListener('dsha:foreground', nativeForeground)
}
function detach(): void {
  if (!attached || clients.size !== 0) return
  document.removeEventListener('visibilitychange', visibility)
  window.removeEventListener('pagehide', pageHide)
  window.removeEventListener('pageshow', focus)
  window.removeEventListener('focus', focus)
  window.removeEventListener('dsha:background', nativeBackgroundSignal)
  window.removeEventListener('dsha:foreground', nativeForeground)
  attached = false
  background = false
  nativeBackground = false
  foregroundPending = false
  if (foregroundTimer !== undefined) clearTimeout(foregroundTimer)
  foregroundTimer = undefined
  recoveryScopes.clear()
}

/** Shared lifecycle listeners, per-renderer playback progress and disposal. */
export function useBackgroundRecovery(mode: BackgroundRecovery, onHidden: () => void, onResume: () => void,
  scopeKey?: string, scopePosition?: RecoveryPosition, resumeOnMount = false, active = true) {
  const keyRef = useRef(scopeKey)
  keyRef.current = scopeKey
  const positionRef = useRef(scopePosition)
  positionRef.current = scopePosition
  const callbacks = useRef({ onHidden, onResume })
  callbacks.current = { onHidden, onResume }
  const state = useRef({ mode, recovering: false, resumed: false, wasHidden: false, waitingSync: false })
  state.current.mode = mode
  useLayoutEffect(() => {
    if (!active) {
      state.current.recovering = false
      state.current.resumed = false
      state.current.wasHidden = false
      state.current.waitingSync = false
      return
    }
    attach()
    const client: RecoveryClient = {
      key: () => keyRef.current,
      position: () => positionRef.current,
      recovering: () => state.current.recovering || state.current.wasHidden,
      waitingForSync: () => state.current.waitingSync,
      hidden: () => {
        state.current.wasHidden = true
        state.current.waitingSync = false
        callbacks.current.onHidden()
      },
      resume: () => {
        state.current.wasHidden = false
        state.current.waitingSync = false
        state.current.recovering = true
        state.current.resumed = true
        callbacks.current.onResume()
      },
      synchronized: () => { state.current.waitingSync = false; callbacks.current.onResume() },
    }
    clients.add(client)
    // Late publications inherit the same turn's recovery until its queues drain.
    // Historical rows in another turn do not inherit a recent foreground event.
    const key = keyRef.current
    state.current.recovering = resumeOnMount || (key !== undefined && isBackgroundRecoveryScope(key, positionRef.current))
    state.current.resumed = state.current.recovering
    if (key !== undefined) synchronization?.pending(key)
    if (background) {
      rememberScope(key, positionRef.current)
      client.hidden()
    }
    return () => {
      clients.delete(client)
      retireScopes()
      detach()
    }
  }, [active])
  useLayoutEffect(() => {
    // Observe a new Session before its connection can enter recovery.
    if (scopeKey !== undefined) synchronization?.pending(scopeKey)
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
      state.current.waitingSync = false
      retireScopes()
    },
    finish: (): void => {
      const key = keyRef.current
      if (key !== undefined && synchronization?.pending(key) === true) {
        state.current.waitingSync = true
        return
      }
      state.current.waitingSync = false
      state.current.recovering = false
      state.current.resumed = false
      retireScopes()
    },
    detectGap: (elapsed: number): void => {
      if (elapsed >= BACKGROUND_GAP_MS) {
        state.current.recovering = true
        // A slow foreground frame can trigger bounded playback, but does not
        // count as a WebView foreground transition for disclosure policy.
      }
    },
  }
}

/** Per-frame fractional budget; the character cap is unchanged and long stalls never accrue whole-token debt. */
export function recoveryBudget(backlog: number, elapsedMs: number, debt: number, tuning: StreamDebugTuning, retainDebt = false) {
  if (backlog <= 0 || elapsedMs <= 0) return { chars: 0, debt: backlog <= 0 ? 0 : Math.max(0, debt) % 1 }
  const cps = Math.min(400, Math.max(120, tuning.maxRevealCps * tuning.revealScale * 1.5))
  const budget = cps * Math.min(elapsedMs, 80) / 1000 + Math.max(0, debt) % 1
  const chars = Math.min(backlog, RECOVERY_MAX_CHARS, Math.floor(budget))
  return { chars, debt: chars >= backlog && !retainDebt ? 0 : budget % 1 }
}
