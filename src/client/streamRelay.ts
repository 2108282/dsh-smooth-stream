type Listener = () => void

export interface RelayScope {
  session: string
  turn: string
  step: number
  node: string
  order: number
}
export type RelayPart = 'reasoning' | 'response' | 'tool'
interface Lease {
  scope: RelayScope
  part: RelayPart
  active: boolean
}
const PART_ORDER: Record<RelayPart, number> = { reasoning: 0, response: 1, tool: 2 }

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
    order: Number(n.anchorSeq ?? 0),
  }
}

function sameTurn(a: RelayScope, b: RelayScope): boolean {
  return a.session === b.session && a.turn === b.turn
}
function precedes(a: Lease, scope: RelayScope, part: RelayPart): boolean {
  if (!sameTurn(a.scope, scope)) return false
  if (a.scope.step !== scope.step) return a.scope.step < scope.step
  if (a.scope.node === scope.node) return PART_ORDER[a.part] < PART_ORDER[part]
  if (a.scope.order !== scope.order) return a.scope.order < scope.order
  return PART_ORDER[a.part] < PART_ORDER[part]
}

/** Every mounted renderer owns a token; another viewport cannot release its work. */
export class StreamRelay {
  private readonly leases = new Map<symbol, Lease>()
  private readonly legacy = new Map<string, { reasoning: boolean; response: boolean }>()
  private readonly listeners = new Set<Listener>()

  acquire(scope: RelayScope, part: RelayPart, active = true): symbol {
    const token = Symbol(part)
    this.leases.set(token, { scope, part, active })
    this.notify()
    return token
  }

  update(token: symbol, active: boolean): void {
    const lease = this.leases.get(token)
    if (lease === undefined || lease.active === active) return
    lease.active = active
    this.notify()
  }

  release(token: symbol): void {
    if (this.leases.delete(token)) this.notify()
  }

  isBlocked(scope: RelayScope, part: RelayPart): boolean {
    for (const lease of this.leases.values()) {
      if (lease.active && lease.part !== 'tool' && precedes(lease, scope, part)) return true
    }
    return false
  }

  hasTool(scope: RelayScope): boolean {
    for (const lease of this.leases.values()) {
      if (lease.part === 'tool' && sameTurn(lease.scope, scope) && lease.scope.step === scope.step) return true
    }
    return false
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
    this.notify()
  }
  isReasoningActive(key?: string | null): boolean { return this.legacy.get(key ?? 'active')?.reasoning ?? false }
  isTextActive(key?: string | null): boolean { return this.legacy.get(key ?? 'active')?.response ?? false }
  isToolBlocked(key?: string | null): boolean { return this.isReasoningActive(key) || this.isTextActive(key) }
  resetTurn(key?: string | null): void {
    if (this.legacy.delete(key ?? 'active')) this.notify()
  }
  clearAll(): void {
    if (this.leases.size === 0 && this.legacy.size === 0) return
    this.leases.clear()
    this.legacy.clear()
    this.notify()
  }
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private notify(): void { for (const listener of [...this.listeners]) listener() }
}

export const streamRelay = new StreamRelay()
