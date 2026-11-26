import { useCallback, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import { relayTurnKey, streamRelay, type RelayPart, type RelayScope } from './streamRelay.ts'

interface Admission {
  token: symbol | string
  scope: RelayScope
  part: RelayPart
  root: RefObject<HTMLElement | null>
  ordinal: number
  admitted: boolean
  committed: boolean
  pending: boolean
  reservedEpoch: number | undefined
  refs: number
}

const admissions = new Map<symbol | string, Admission>()
const subscriptions = new Map<symbol | string, Set<() => void>>()
const admissionListeners = new Set<() => void>()
let admissionRevision = 0
let ordinal = 0
let scheduled = false
const PART_ORDER: Record<RelayPart, number> = { reasoning: 0, response: 1, tool: 2, output: 2 }

interface SourceSnapshot {
  key: string
  epoch: number
  source: unknown
  holders: Set<symbol>
}
const sourceSnapshots = new Map<string, SourceSnapshot>()
const nodeSources = new Map<string, Set<SourceSnapshot>>()
const sourceListeners = new Map<string, Set<() => void>>()

function sourceKey(session: string, node: string): string { return JSON.stringify([session, node]) }
function publishSource(key: string): void {
  for (const listener of [...sourceListeners.get(key) ?? []]) listener()
}
export function readPresentationSource(session: string, node: string): unknown {
  const key = sourceKey(session, node)
  let first: SourceSnapshot | undefined
  for (const snapshot of nodeSources.get(key) ?? []) {
    if (first === undefined || snapshot.epoch < first.epoch) first = snapshot
  }
  return first?.source
}
export function subscribePresentationSource(session: string, node: string, listener: () => void): () => void {
  const key = sourceKey(session, node)
  const listeners = sourceListeners.get(key) ?? new Set<() => void>()
  sourceListeners.set(key, listeners)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) sourceListeners.delete(key)
  }
}
export function reservePresentationSource(ownerKey: string, scope: RelayScope, epoch: number, source: unknown): () => void {
  const snapshot = sourceSnapshots.get(ownerKey) ?? {
    key: sourceKey(scope.session, scope.node), epoch, source, holders: new Set<symbol>(),
  }
  const holder = Symbol('presentation-source')
  snapshot.holders.add(holder)
  sourceSnapshots.set(ownerKey, snapshot)
  const snapshots = nodeSources.get(snapshot.key) ?? new Set<SourceSnapshot>()
  snapshots.add(snapshot)
  nodeSources.set(snapshot.key, snapshots)
  publishSource(snapshot.key)
  return () => {
    snapshot.holders.delete(holder)
    if (snapshot.holders.size > 0 || sourceSnapshots.get(ownerKey) !== snapshot) return
    finishPresentationSource(ownerKey)
  }
}
function finishPresentationSource(ownerKey: string | undefined): void {
  if (ownerKey === undefined) return
  const snapshot = sourceSnapshots.get(ownerKey)
  if (snapshot === undefined) return
  sourceSnapshots.delete(ownerKey)
  const snapshots = nodeSources.get(snapshot.key)
  snapshots?.delete(snapshot)
  if (snapshots?.size === 0) nodeSources.delete(snapshot.key)
  publishSource(snapshot.key)
}

function publishAdmissions(): void {
  admissionRevision += 1
  for (const listener of [...admissionListeners]) listener()
}

export function presentationOwnerKey(scope: RelayScope, part: RelayPart): string {
  return JSON.stringify([scope.session, scope.turn, scope.step, scope.node, part])
}

export function presentationAdmissionSnapshot(): number {
  return admissionRevision
}

export function subscribePresentationAdmissions(listener: () => void): () => void {
  admissionListeners.add(listener)
  return () => { admissionListeners.delete(listener) }
}

export function presentationOwnerAdmitted(ownerKey: string): boolean | undefined {
  return admissions.get(ownerKey)?.admitted
}

export function subscribePresentationOwner(ownerKey: string, listener: () => void): () => void {
  const listeners = subscriptions.get(ownerKey) ?? new Set<() => void>()
  listeners.add(listener)
  subscriptions.set(ownerKey, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) subscriptions.delete(ownerKey)
  }
}

function compare(left: Admission, right: Admission): number {
  // First creation follows source/flow order. Recovery may yield an earlier
  // row's next batch to an older snapshot without moving either owner's seat.
  const step = left.scope.step - right.scope.step
  if (step !== 0) return step
  const source = (left.scope.sourceOrder ?? left.scope.order) - (right.scope.sourceOrder ?? right.scope.order)
  if (Number.isFinite(source) && source !== 0) return source
  if (left.scope.node === right.scope.node) {
    const part = PART_ORDER[left.part] - PART_ORDER[right.part]
    if (part !== 0) return part
  }
  // Empty owner seats already occupy the Host's authoritative flow order. Use
  // that order for equal anchors, never a tool/category or node-name ordering.
  const a = left.root.current
  const b = right.root.current
  if (a !== null && b !== null && a !== b && a.isConnected && b.isConnected) {
    const position = a.compareDocumentPosition(b)
    if ((position & Node.DOCUMENT_POSITION_DISCONNECTED) === 0) {
      if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return -1
      if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 1
    }
  }
  return left.ordinal - right.ordinal
}

function scheduleAdmissions(): void {
  if (scheduled) return
  scheduled = true
  // All sibling owners reserve before any actual renderer is invoked. Checking
  // isBlocked during render would let every first-render sibling slip through.
  queueMicrotask(() => {
    scheduled = false
    const turns = new Map<string, Admission[]>()
    for (const entry of admissions.values()) {
      const key = relayTurnKey(entry.scope)
      const items = turns.get(key) ?? []
      items.push(entry)
      turns.set(key, items)
    }
    const changed: Admission[] = []
    for (const items of turns.values()) {
      let pendingOwner = false
      let unbatchedPredecessor = false
      let earliestPendingEpoch = Number.POSITIVE_INFINITY
      for (const entry of items.sort(compare)) {
        // A mounted row may already be waiting on its next recovery suffix.
        // Only an explicitly older batch can pass it; ordinary live prefixes
        // retain their source-order priority while their epoch is initialized.
        const epoch = entry.scope.recoveryEpoch
        const predecessor = pendingOwner && (unbatchedPredecessor || epoch === undefined
          || entry.reservedEpoch !== epoch || earliestPendingEpoch <= epoch)
        if (!entry.admitted && !predecessor && !streamRelay.isBlocked(entry.scope, entry.part)) {
          entry.admitted = true
          changed.push(entry)
        }
        if (entry.admitted && (!entry.committed || entry.pending)) {
          pendingOwner = true
          if (epoch === undefined) unbatchedPredecessor = true
          else earliestPendingEpoch = Math.min(earliestPendingEpoch, epoch)
        }
      }
    }
    if (changed.length > 0) {
      publishAdmissions()
      for (const entry of changed) {
        const listeners = subscriptions.get(entry.token)
        if (listeners !== undefined) for (const listener of [...listeners]) listener()
      }
    }
  })
}

/**
 * Reserve an owner without creating its actual renderer, icon or card DOM.
 * Admission is latched: a later pause never unmounts an already presented row.
 */
export function usePresentationAdmission(
  scope: RelayScope,
  part: RelayPart,
  enabled: boolean,
  pending: boolean,
  root: RefObject<HTMLElement | null>,
  initiallyPresented = false,
  ownerKey?: string,
  reserveOnly = false,
): boolean {
  const tokenRef = useRef<{ ownerKey: string | undefined; token: symbol | string } | null>(null)
  if (tokenRef.current === null || tokenRef.current.ownerKey !== ownerKey) {
    tokenRef.current = { ownerKey, token: ownerKey ?? Symbol('presentation-admission') }
  }
  const token = tokenRef.current!.token
  const presented = useRef(initiallyPresented || !enabled)
  if (!enabled) presented.current = true
  const current = useRef({ scope, part, pending, root })
  current.current = { scope, part, pending, root }
  const subscribe = useCallback((listener: () => void) => {
    const listeners = subscriptions.get(token) ?? new Set<() => void>()
    listeners.add(listener)
    subscriptions.set(token, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) subscriptions.delete(token)
    }
  }, [token])
  const read = useCallback(() => presented.current || admissions.get(token)?.admitted === true, [token])
  const admitted = useSyncExternalStore(subscribe, read, read)
  if (admitted) presented.current = true

  useLayoutEffect(() => {
    if (!enabled) return
    const existing = admissions.get(token)
    if (existing !== undefined) {
      existing.refs += 1
    } else if (!presented.current) {
      const value = current.current
      admissions.set(token, {
        token, ...value, ordinal: ordinal++, admitted: false, committed: false, pending: true,
        reservedEpoch: reserveOnly ? value.scope.recoveryEpoch : undefined, refs: 1,
      })
    } else {
      return
    }
    publishAdmissions()
    scheduleAdmissions()
    return () => {
      const entry = admissions.get(token)
      if (entry !== undefined) {
        entry.refs -= 1
        if (entry.refs <= 0) admissions.delete(token)
      }
      publishAdmissions()
      scheduleAdmissions()
    }
  }, [enabled, scope.session, scope.turn, scope.node, part, token])

  useLayoutEffect(() => {
    if (!enabled || !admissions.has(token)) return
    return streamRelay.subscribeBlocked(scope, part, scheduleAdmissions)
  }, [enabled, scope.session, scope.turn, scope.step, scope.node, scope.order, scope.sourceOrder, scope.recoveryEpoch, part, token])

  useLayoutEffect(() => {
    const entry = admissions.get(token)
    if (entry === undefined) return
    if (reserveOnly) {
      // Before creation the reservation follows recovery itself. Afterward its
      // parent layout effect must not overwrite the member's live batch scope.
      if (!admitted) {
        entry.scope = scope
        entry.reservedEpoch = scope.recoveryEpoch
        publishAdmissions()
        scheduleAdmissions()
      }
      if (admitted && !entry.committed) {
        entry.committed = true
        entry.pending = pending
        publishAdmissions()
        scheduleAdmissions()
      }
      return
    }
    entry.scope = scope
    entry.root = root
    if (admitted) {
      // This layout phase follows the actual Inner's first commit, including
      // icon-only/empty renderers. An empty pre-admission seat is not drained.
      entry.committed = true
      entry.pending = pending
    }
    publishAdmissions()
    scheduleAdmissions()
  }, [admitted, pending, root, reserveOnly, scope.session, scope.turn, scope.step, scope.node, scope.order, scope.sourceOrder, scope.recoveryEpoch, token])

  useLayoutEffect(() => {
    if (!reserveOnly && admitted && !pending) finishPresentationSource(ownerKey)
  }, [admitted, pending, reserveOnly, ownerKey])

  return admitted
}
