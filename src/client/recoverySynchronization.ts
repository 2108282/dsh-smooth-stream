import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { Context } from '@deepseek-ai/cordis'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { installRecoverySynchronization, notifyRecoverySynchronized, type RecoverySynchronization } from './backgroundRecovery.ts'

// Structural subset of the documented Session Controller face. Keeping the
// service boundary structural avoids a runtime import or a second controller.
type SessionId = ChatNodeViewProps<'assistant-step'>['sessionId']
interface Source<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}
interface SessionBinding {
  sessionId: SessionId
  session: Source<{ readonly openState: string }>
  eventSource: Source<{ readonly change: { readonly kind: string } }>
  ctx: Pick<Context, 'effect'>
}
interface Sessions {
  binding(sessionId: SessionId): SessionBinding | undefined
}

interface TrackedSession {
  binding: SessionBinding
  awaitingBaseline: boolean
  dispose: () => void
}

/** Borrow existing Session feeds; never open another stream or force a reconnect. */
export function bindRecoverySynchronization(sessions: Sessions, connection: ConnectionHandle): () => void {
  const tracked = new Map<string, TrackedSession>()
  let generation = connection.generation.getSnapshot()?.id
  let disposed = false
  const connected = () => connection.state.getSnapshot() === 'connected'
    && connection.generation.getSnapshot() !== undefined
  const wake = () => {
    // Feed subscribers include Conversation assembly. Let the entire accepted
    // baseline publication finish before an empty renderer retires its scope.
    queueMicrotask(() => { if (!disposed) notifyRecoverySynchronized() })
  }
  const observe = (sessionId: string): TrackedSession | undefined => {
    const binding = sessions.binding(sessionId as SessionBinding['sessionId'])
    const previous = tracked.get(sessionId)
    if (previous?.binding === binding) return previous
    previous?.dispose()
    if (binding === undefined) return undefined
    const entry: TrackedSession = {
      binding,
      awaitingBaseline: !connected(),
      dispose: () => {},
    }
    tracked.set(sessionId, entry)
    const offFeed = binding.eventSource.subscribe(() => {
      if (binding.eventSource.getSnapshot().change.kind !== 'replace') return
      // A replaced contiguous window is the Session-owned synchronization
      // acknowledgement, including an empty/unchanged baseline.
      entry.awaitingBaseline = false
      wake()
    })
    let openState = binding.session.getSnapshot().openState
    const offSession = binding.session.subscribe(() => {
      const next = binding.session.getSnapshot().openState
      if (next === openState) return
      openState = next
      wake()
    })
    let active = true
    entry.dispose = () => {
      if (!active) return
      active = false
      offFeed()
      offSession()
      if (tracked.get(sessionId) === entry) tracked.delete(sessionId)
    }
    binding.ctx.effect(() => entry.dispose, 'smooth-stream: borrowed recovery feed')
    return entry
  }
  const source: RecoverySynchronization = {
    pending(key) {
      let sessionId: unknown
      try { sessionId = (JSON.parse(key) as unknown[])[0] } catch { return false }
      if (typeof sessionId !== 'string') return false
      const entry = observe(sessionId)
      if (entry === undefined) return false
      const openState = entry.binding.session.getSnapshot().openState
      // A terminal read error is not an everlasting pending synchronization.
      if (openState === 'error') return false
      return !connected() || entry.awaitingBaseline || openState === 'cold' || openState === 'loading'
    },
  }
  const offFence = installRecoverySynchronization(source)
  const connectionChanged = () => {
    const next = connection.generation.getSnapshot()?.id
    if (!connected() || next !== generation) {
      for (const entry of tracked.values()) entry.awaitingBaseline = true
    }
    generation = next
    wake()
  }
  const offGeneration = connection.generation.subscribe(connectionChanged)
  const offState = connection.state.subscribe(connectionChanged)
  return () => {
    disposed = true
    offGeneration()
    offState()
    for (const entry of [...tracked.values()]) entry.dispose()
    offFence()
  }
}
