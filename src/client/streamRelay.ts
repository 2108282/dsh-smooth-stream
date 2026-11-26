type Listener = () => void

export interface RelayScope {
  session: string
  turn: string
  step: number
  node: string
  order: number
  /** Source event position of the currently pending block, when available. */
  sourceOrder?: number | undefined
  /** Frozen recovery batch; lower epochs drain before later batches in this turn. */
  recoveryEpoch?: number | undefined
}
export type RelayPart = 'reasoning' | 'response' | 'tool' | 'output'
interface Lease {
  turnKey: string
  step: number
  node: string
  order: number
  sourceOrder?: number | undefined
  recoveryEpoch?: number | undefined
  part: RelayPart
  active: boolean
}
const PART_ORDER: Record<RelayPart, number> = { reasoning: 0, response: 1, tool: 2, output: 2 }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** Unknown owners remain local to their node rather than sharing a global active turn. */
export function relayScope(node: unknown, sessionId?: unknown): RelayScope {
  const n = record(node)
  const data = record(n.data)
  const location = record(n.location)
  const root = record(data.root)
  const turn = record(location.turn)
  const step = record(location.step)
  return {
    session: String(sessionId ?? n.sessionId ?? 'unscoped'),
    turn: String(data.turn ?? turn.turn ?? root.turn ?? n.key ?? 'unknown'),
    step: Number(data.step ?? step.step ?? root.step ?? 0),
    node: String(n.key ?? 'unknown'),
    order: typeof n.anchorSeq === 'number' ? n.anchorSeq : Number.NaN,
  }
}

/** Shared recovery identity, isolated from other sessions and historical turns. */
export function relayTurnKey(scope: RelayScope): string {
  return JSON.stringify([scope.session, scope.turn])
}

function lowerBound<T>(items: readonly T[], before: (value: T) => boolean): number {
  let start = 0
  let end = items.length
  while (start < end) {
    const middle = (start + end) >>> 1
    if (before(items[middle]!)) start = middle + 1
    else end = middle
  }
  return start
}

interface Position {
  order: number
  part: number
}

function positionForLease(lease: Lease): Position {
  return {
    order: Number.isFinite(lease.sourceOrder) ? lease.sourceOrder! : lease.order,
    part: PART_ORDER[lease.part],
  }
}

function positionForScope(scope: RelayScope, part: number): Position {
  return {
    order: Number.isFinite(scope.sourceOrder) ? scope.sourceOrder! : scope.order,
    part,
  }
}

function before(left: Position, right: Position): boolean {
  if (!Number.isFinite(left.order) || !Number.isFinite(right.order)) return false
  return left.order < right.order || (left.order === right.order && left.part < right.part)
}

interface NodeActivity {
  // Keep duplicates so multiple viewport leases for the same position retire independently.
  ordered: Position[]
  counts: [number, number, number]
}

interface NodeFrontier extends Position { node: string }

/** Same-node ordering is by part; cross-node ordering is by event position. */
class StepActivity {
  private readonly nodes = new Map<string, NodeActivity>()
  private readonly frontier: NodeFrontier[] = []

  get empty(): boolean { return this.nodes.size === 0 }

  change(lease: Lease, active: boolean): void {
    const part = PART_ORDER[lease.part]
    const position = positionForLease(lease)
    const activity = this.nodes.get(lease.node) ?? { ordered: [], counts: [0, 0, 0] }
    const previous = activity.ordered[0]
    activity.counts[part] = activity.counts[part]! + (active ? 1 : -1)
    // An unknown event order cannot precede another node, but its part still orders its own node.
    if (!Number.isNaN(position.order)) {
      const index = lowerBound(activity.ordered, value => before(value, position))
      if (active) activity.ordered.splice(index, 0, position)
      else activity.ordered.splice(index, 1)
    }
    if (activity.counts.some(count => count > 0)) this.nodes.set(lease.node, activity)
    else this.nodes.delete(lease.node)

    const next = activity.ordered[0]
    if (previous?.order === next?.order && previous?.part === next?.part) return
    if (previous !== undefined) {
      // Use the node as a tie-breaker only for finding its entry, never for precedence.
      this.frontier.splice(this.frontierIndex({ ...previous, node: lease.node }), 1)
    }
    if (next !== undefined) {
      const head = { ...next, node: lease.node }
      this.frontier.splice(this.frontierIndex(head), 0, head)
    }
  }

  blocks(scope: RelayScope, part: number): boolean {
    const own = this.nodes.get(scope.node)
    if (own !== undefined && ((part >= 1 && own.counts[0] > 0) || (part >= 2 && own.counts[1] > 0))) return true
    // `part` is meaningful only within the same node. Different nodes may
    // share an assistant step's anchorSeq (or be remounted from one snapshot),
    // but the view props carry no source event position finer than that anchor.
    // Never invent a cross-node order from reasoning/tool/output categories.
    const other = this.frontier.find(entry => entry.node !== scope.node && Number.isFinite(entry.order))
    const target = positionForScope(scope, part)
    if (other === undefined || !Number.isFinite(target.order) || other.order >= target.order) return false
    return true
  }

  private frontierIndex(position: NodeFrontier): number {
    return lowerBound(this.frontier, value => before(value, position)
      || (value.order === position.order && value.part === position.part && value.node < position.node))
  }
}

class TurnActivity {
  private readonly steps: number[] = []
  private readonly byStep = new Map<number, StepActivity>()

  get empty(): boolean { return this.steps.length === 0 }

  change(lease: Lease, active: boolean): void {
    let step = this.byStep.get(lease.step)
    if (step === undefined) {
      step = new StepActivity()
      this.byStep.set(lease.step, step)
      this.steps.splice(lowerBound(this.steps, value => value < lease.step), 0, lease.step)
    }
    step.change(lease, active)
    if (step.empty) {
      this.byStep.delete(lease.step)
      this.steps.splice(lowerBound(this.steps, value => value < lease.step), 1)
    }
  }

  blocks(scope: RelayScope, part: RelayPart): boolean {
    const first = this.steps[0]
    if (first === undefined || !(first <= scope.step)) return false
    return first < scope.step || this.byStep.get(first)!.blocks(scope, PART_ORDER[part])
  }
}

interface Subscription {
  listener: Listener
  query: () => boolean
  previous: boolean
}

/** Every mounted renderer owns a token; another viewport cannot release its work. */
export class StreamRelay {
  private readonly leases = new Map<symbol, Lease>()
  private readonly activeTurns = new Map<string, Map<number | undefined, TurnActivity>>()
  private readonly tools = new Map<string, Map<number, number>>()
  private readonly blockedListeners = new Map<string, Set<Subscription>>()
  private readonly toolListeners = new Map<string, Map<number, Set<Subscription>>>()
  private readonly pending = new Set<Subscription>()
  private readonly legacy = new Map<string, { reasoning: boolean; response: boolean }>()
  private readonly legacyListeners = new Set<Listener>()
  private legacyPending = false
  private notifying = false

  acquire(scope: RelayScope, part: RelayPart, active = true): symbol {
    const token = Symbol(part)
    const lease = { turnKey: relayTurnKey(scope), step: scope.step, node: scope.node, order: scope.order, sourceOrder: scope.sourceOrder, recoveryEpoch: scope.recoveryEpoch, part, active }
    this.leases.set(token, lease)
    if (part === 'tool') this.changeTool(lease, 1)
    if (active) this.changeActive(lease, true)
    this.flushNotifications()
    return token
  }

  update(token: symbol, active: boolean): void {
    const lease = this.leases.get(token)
    if (lease === undefined || lease.active === active) return
    lease.active = active
    this.changeActive(lease, active)
    this.flushNotifications()
  }

  release(token: symbol): void {
    const lease = this.leases.get(token)
    if (lease === undefined) return
    this.leases.delete(token)
    if (lease.active) this.changeActive(lease, false)
    if (lease.part === 'tool') this.changeTool(lease, -1)
    this.flushNotifications()
  }

  /** Lowest mounted active recovery batch; new recovery seats join that batch. */
  recoveryEpoch(scope: RelayScope | string): number | undefined {
    const batches = this.activeTurns.get(typeof scope === 'string' ? scope : relayTurnKey(scope))
    let earliest: number | undefined
    if (batches !== undefined) for (const epoch of batches.keys()) {
      if (epoch !== undefined && (earliest === undefined || epoch < earliest)) earliest = epoch
    }
    return earliest
  }

  isBlocked(scope: RelayScope, part: RelayPart): boolean {
    const batches = this.activeTurns.get(relayTurnKey(scope))
    if (batches === undefined) return false
    const earliest = this.recoveryEpoch(scope)
    // Ordinary new input waits behind recovery. It cannot reclaim an earlier
    // source position after its own frozen batches have already drained.
    if (earliest !== undefined && (scope.recoveryEpoch === undefined || earliest < scope.recoveryEpoch)) return true
    return batches.get(scope.recoveryEpoch)?.blocks(scope, part) ?? false
  }

  hasTool(scope: RelayScope): boolean {
    return this.tools.get(relayTurnKey(scope))?.has(scope.step) ?? false
  }

  subscribeBlocked(scope: RelayScope, part: RelayPart, listener: Listener): () => void {
    const key = relayTurnKey(scope)
    const position = { ...scope }
    return this.subscribeTo(this.blockedListeners, key, listener,
      () => this.isBlocked(position, part))
  }

  subscribeTool(scope: RelayScope, listener: Listener): () => void {
    const key = relayTurnKey(scope)
    const step = scope.step
    const byStep = this.toolListeners.get(key) ?? new Map<number, Set<Subscription>>()
    this.toolListeners.set(key, byStep)
    const stop = this.subscribeTo(byStep, step, listener, () => this.tools.get(key)?.has(step) ?? false)
    return () => {
      stop()
      if (byStep.size === 0 && this.toolListeners.get(key) === byStep) this.toolListeners.delete(key)
    }
  }

  private subscribeTo<K>(groups: Map<K, Set<Subscription>>, key: K, listener: Listener, query: () => boolean): () => void {
    const group = groups.get(key) ?? new Set<Subscription>()
    const subscription = { listener, query, previous: query() }
    group.add(subscription)
    groups.set(key, group)
    return () => {
      if (!group.delete(subscription)) return
      this.pending.delete(subscription)
      if (group.size === 0) groups.delete(key)
    }
  }

  private changeActive(lease: Lease, active: boolean): void {
    if (Number.isNaN(lease.step)) return
    const batches = this.activeTurns.get(lease.turnKey) ?? new Map<number | undefined, TurnActivity>()
    const turn = batches.get(lease.recoveryEpoch) ?? new TurnActivity()
    turn.change(lease, active)
    if (turn.empty) batches.delete(lease.recoveryEpoch)
    else batches.set(lease.recoveryEpoch, turn)
    if (batches.size === 0) this.activeTurns.delete(lease.turnKey)
    else this.activeTurns.set(lease.turnKey, batches)
    this.enqueue(this.blockedListeners.get(lease.turnKey))
  }

  private changeTool(lease: Lease, delta: number): void {
    if (Number.isNaN(lease.step)) return
    const byStep = this.tools.get(lease.turnKey) ?? new Map<number, number>()
    const previous = byStep.get(lease.step) ?? 0
    const next = previous + delta
    if (next === 0) byStep.delete(lease.step)
    else byStep.set(lease.step, next)
    if (byStep.size === 0) this.tools.delete(lease.turnKey)
    else this.tools.set(lease.turnKey, byStep)
    if ((previous === 0) !== (next === 0)) this.enqueue(this.toolListeners.get(lease.turnKey)?.get(lease.step))
  }

  private enqueue(subscriptions: Set<Subscription> | undefined): void {
    if (subscriptions !== undefined) for (const subscription of subscriptions) this.pending.add(subscription)
  }

  private flushNotifications(): void {
    if (this.notifying) return
    this.notifying = true
    try {
      // Reentrant mutations queue work in the same drain. Always compare the
      // current snapshot, so a callback cannot deliver a stale result to its successors.
      while (this.pending.size > 0 || this.legacyPending) {
        const subscription = this.pending.values().next().value
        if (subscription !== undefined) {
          this.pending.delete(subscription)
          const current = subscription.query()
          if (current === subscription.previous) continue
          subscription.previous = current
          subscription.listener()
        } else {
          this.legacyPending = false
          for (const listener of [...this.legacyListeners]) {
            if (this.legacyListeners.has(listener)) listener()
          }
        }
      }
    } finally {
      this.notifying = false
    }
  }

  // Compatibility for the previous renderer. Explicit keys never fall through
  // into another turn; the native renderer exclusively uses scoped leases.
  setReasoningActive(key: string | undefined, active: boolean): void { this.setLegacy(key, 'reasoning', active) }
  setTextActive(key: string | undefined, active: boolean): void { this.setLegacy(key, 'response', active) }
  private setLegacy(key: string | undefined, part: 'reasoning' | 'response', active: boolean): void {
    const id = key ?? 'active'
    const state = this.legacy.get(id) ?? { reasoning: false, response: false }
    if (state[part] === active) return
    state[part] = active
    if (!state.reasoning && !state.response) this.legacy.delete(id)
    else this.legacy.set(id, state)
    this.legacyPending = true
    this.flushNotifications()
  }
  isReasoningActive(key?: string | null): boolean { return this.legacy.get(key ?? 'active')?.reasoning ?? false }
  isTextActive(key?: string | null): boolean { return this.legacy.get(key ?? 'active')?.response ?? false }
  isToolBlocked(key?: string | null): boolean { return this.isReasoningActive(key) || this.isTextActive(key) }
  resetTurn(key?: string | null): void {
    if (!this.legacy.delete(key ?? 'active')) return
    this.legacyPending = true
    this.flushNotifications()
  }
  clearAll(): void {
    for (const key of this.activeTurns.keys()) this.enqueue(this.blockedListeners.get(key))
    for (const [key, byStep] of this.tools) {
      const listeners = this.toolListeners.get(key)
      if (listeners !== undefined) for (const step of byStep.keys()) this.enqueue(listeners.get(step))
    }
    this.leases.clear()
    this.activeTurns.clear()
    this.tools.clear()
    if (this.legacy.size > 0) {
      this.legacy.clear()
      this.legacyPending = true
    }
    this.flushNotifications()
  }
  subscribe = (listener: Listener): (() => void) => {
    this.legacyListeners.add(listener)
    return () => { this.legacyListeners.delete(listener) }
  }
}

export const streamRelay = new StreamRelay()
