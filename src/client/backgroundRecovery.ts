import { useLayoutEffect, useRef } from 'react'
import type { BackgroundRecovery, StreamDebugTuning } from '../settings.ts'

/** A stalled WebView may not deliver visibility events; only a long frame gap is a fallback. */
export const BACKGROUND_GAP_MS = 1000
export const RECOVERY_COMMIT_MS = 40
export const RECOVERY_MAX_CHARS = 16

interface RecoveryClient {
  hidden: () => void
  resume: () => void
}
const clients = new Set<RecoveryClient>()
let attached = false
let background = false
let resumedAt: number | null = null

function hide(): void {
  if (background) return
  background = true
  for (const client of [...clients]) client.hidden()
}
function show(): void {
  if (!background) return
  background = false
  resumedAt = performance.now()
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
  window.addEventListener('blur', hide)
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
  window.removeEventListener('blur', hide)
  window.removeEventListener('focus', focus)
  window.removeEventListener('dsha:background', hide)
  window.removeEventListener('dsha:foreground', show)
  attached = false
  background = false
  resumedAt = null
}

/** Shared lifecycle listeners, per-renderer playback progress and disposal. */
export function useBackgroundRecovery(mode: BackgroundRecovery, onHidden: () => void, onResume: () => void) {
  const callbacks = useRef({ onHidden, onResume })
  callbacks.current = { onHidden, onResume }
  const state = useRef({ mode, recovering: false, wasHidden: false, awaitingData: false })
  state.current.mode = mode
  useLayoutEffect(() => {
    attach()
    const client = {
      hidden: () => { state.current.wasHidden = true; callbacks.current.onHidden() },
      resume: () => {
        state.current.wasHidden = false
        state.current.recovering = true
        state.current.awaitingData = true
        callbacks.current.onResume()
      },
    }
    clients.add(client)
    // Nodes first materialized by a resume publication inherit its playback policy.
    state.current.recovering = resumedAt !== null && performance.now() - resumedAt < 1000
    state.current.awaitingData = state.current.recovering
    if (background) client.hidden()
    return () => { clients.delete(client); detach() }
  }, [])
  return {
    hidden: (): boolean => background,
    mode: (): BackgroundRecovery => state.current.mode,
    recovering: (): boolean => state.current.recovering,
    observeBacklog: (pending: boolean): void => { if (pending) state.current.awaitingData = false },
    finish: (): void => { if (!state.current.awaitingData) state.current.recovering = false },
    detectGap: (elapsed: number): void => {
      if (elapsed >= BACKGROUND_GAP_MS) { state.current.recovering = true; state.current.awaitingData = false }
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
