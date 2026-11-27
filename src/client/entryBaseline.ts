import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'

/** Only the borrowed, observable faces are needed; this helper never retains a Session. */
interface SnapshotSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}
interface EntryEvent {
  readonly type: string
  readonly seq: number
  readonly surfaceOp?: unknown
  readonly data: unknown
}
interface Entry {
  readonly type: string
  readonly event: EntryEvent
}
export interface EntryBaselineWindow {
  readonly entries: readonly Entry[]
  readonly revision: number
  readonly change: {
    readonly kind: 'replace' | 'prepend' | 'append' | 'settle-assistant'
    readonly entries?: readonly Entry[]
    readonly attemptId?: string
    readonly entry?: Entry
  }
}
export interface EntryBaselineBinding {
  readonly session: SnapshotSource<{ readonly openState: 'cold' | 'loading' | 'open' | 'error' }>
  readonly eventSource: SnapshotSource<EntryBaselineWindow>
}
export interface EntryBaselineSource {
  binding(id: SessionId): EntryBaselineBinding | undefined
}

export interface EntryBlockSource {
  readonly turn: number
  readonly step: number
  readonly attemptId: string | undefined
  /** Raw/wire index, never the official compact node.data.blocks index. */
  readonly blockIndex: number | undefined
  readonly blockSeq: number | undefined
}
export interface EntryBlockBaseline {
  /** A UTF-16 prefix of the supplied text. Use Array.from(initialText).length for playback points. */
  readonly initialText: string
  readonly animate: boolean
  /** Changes on replacement/rebind, even when the attempt and wire index stay the same. */
  readonly generation: string
}
export interface EntryBaseline {
  readBlock(source: EntryBlockSource, text: string): EntryBlockBaseline
  /** Recover the exact wire identity after the official assembler retires an attempt. */
  settledBlock(turn: number, step: number, seq: number, index: number, kind: string): EntryBlockSource | undefined
  /** Exact event seq; callers using synthetic Chat seq offsets must remove those offsets. */
  isLiveSeq(seq: number): boolean
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => number
  dispose(): void
}

interface BlockLength {
  readonly seq: number
  readonly kind: string
  length: number
  baseline: number
  live: boolean
}
interface ChunkData {
  readonly attemptId?: unknown
  readonly turn?: unknown
  readonly step?: unknown
  readonly chunk?: {
    readonly type?: unknown
    readonly index?: unknown
    readonly blockType?: unknown
    readonly text?: unknown
    readonly block?: { readonly type?: unknown; readonly text?: unknown }
  }
}

let sessions: EntryBaselineSource | undefined
let nextEpoch = 0
const observers = new Set<Baseline>()
interface FallbackBaselineRecord {
  readonly source: EntryBaselineSource
  readonly baseline: EntryBaseline
  readonly leases: Set<symbol>
}
const fallbackBaselines = new Map<string, FallbackBaselineRecord>()
const FALLBACK_BASELINE_LIMIT = 8

/**
 * A fallback Chat renderer has no Flow scope to own its entry baseline. Share
 * one baseline across its rows so a later mount can distinguish session history
 * from events appended after the first row entered the view.
 */
export interface FallbackEntryBaseline {
  readonly baseline: EntryBaseline
  retain(): () => void
}

/** Install once from the Client context, and return its context-owned disposer. */
export function installEntryBaselineSource(source: EntryBaselineSource): () => void {
  const previous = sessions
  sessions = source
  for (const observer of observers) observer.refresh()
  return () => {
    if (sessions !== source) return
    sessions = previous
    for (const observer of observers) observer.refresh()
  }
}

/** Create at session entry, before delayed Conversation/React publications, and dispose at departure. */
export function createEntryBaseline(sessionId: string): EntryBaseline {
  const baseline = new Baseline(sessionId)
  baseline.refresh()
  return baseline
}

/** Shared baseline for keyed renderers that run without SessionPlaybackFlow. */
export function getFallbackEntryBaseline(sessionId: string): FallbackEntryBaseline | undefined {
  const source = sessions
  if (source === undefined) return undefined
  let record = fallbackBaselines.get(sessionId)
  if (record !== undefined && record.source !== source) {
    record.baseline.dispose()
    fallbackBaselines.delete(sessionId)
    record = undefined
  }
  if (record === undefined) {
    const baseline = createEntryBaseline(sessionId)
    record = { source, baseline, leases: new Set() }
  } else {
    fallbackBaselines.delete(sessionId)
  }
  fallbackBaselines.set(sessionId, record)

  while (fallbackBaselines.size > FALLBACK_BASELINE_LIMIT) {
    const candidate = [...fallbackBaselines.entries()].find(([key, value]) =>
      key !== sessionId && value.leases.size === 0)
    if (candidate === undefined) break
    fallbackBaselines.delete(candidate[0])
    candidate[1].baseline.dispose()
  }

  return {
    baseline: record.baseline,
    retain: () => {
      if (record!.leases.size === 0) {
        // Keep source revisions contiguous only while committed fallback rows exist.
        record!.baseline.subscribe(() => {})
      }
      const token = Symbol(sessionId)
      record!.leases.add(token)
      return () => queueMicrotask(() => {
        if (!record!.leases.delete(token) || record!.leases.size !== 0) return
        if (fallbackBaselines.get(sessionId) !== record) return
        fallbackBaselines.delete(sessionId)
        record!.baseline.dispose()
      })
    },
  }
}

function blockKey(turn: number, step: number, attemptId: string, index: number): string {
  return JSON.stringify([turn, step, attemptId, index])
}

function safePrefix(text: string, length: number): string {
  let end = Math.min(length, text.length)
  const before = text.charCodeAt(end - 1)
  const after = text.charCodeAt(end)
  if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end--
  return text.slice(0, end)
}

/** Length/provenance metadata only. Official Conversation remains the content assembler. */
class Baseline implements EntryBaseline {
  private binding: EntryBaselineBinding | undefined
  private epoch = ++nextEpoch
  private revision = 0
  private sourceRevision: number | undefined
  private ready = false
  private disposed = false
  private readonly blocks = new Map<string, BlockLength>()
  private readonly liveSeqs = new Set<number>()
  private readonly liveMessages = new Set<number>()
  private readonly settlements = new Map<string, readonly EntryBlockSource[]>()
  private readonly listeners = new Set<() => void>()
  private unsubscribe: (() => void)[] = []

  constructor(private readonly sessionId: string) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    observers.add(this)
    this.refresh()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size !== 0) return
      for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe()
      observers.delete(this)
    }
  }
  readonly getSnapshot = (): number => this.revision

  refresh(): void {
    if (this.disposed) return
    const binding = sessions?.binding(this.sessionId as SessionId)
    if (binding !== this.binding) {
      for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe()
      this.binding = binding
      this.reset()
      this.capture()
      this.publish()
    } else this.capture()
    if (binding !== undefined && this.listeners.size !== 0 && this.unsubscribe.length === 0) {
      // Attaching is a subscription effect, never a render-time side effect.
      // An abandoned StrictMode render therefore owns no source listeners.
      this.unsubscribe.push(binding.eventSource.subscribe(() => this.capture()))
      this.unsubscribe.push(binding.session.subscribe(() => this.capture()))
      this.capture()
    }
  }

  private reset(): void {
    this.epoch = ++nextEpoch
    this.sourceRevision = undefined
    this.ready = false
    this.blocks.clear()
    this.liveSeqs.clear()
    this.liveMessages.clear()
    this.settlements.clear()
  }

  private capture(): void {
    const binding = this.binding
    if (binding === undefined || this.disposed) return
    const window = binding.eventSource.getSnapshot()
    const open = binding.session.getSnapshot().openState === 'open'
    if (this.sourceRevision === window.revision) {
      if (!this.ready && open) { this.ready = true; this.publish() }
      return
    }
    const initial = this.sourceRevision === undefined
    const contiguous = initial || window.revision === this.sourceRevision! + 1
    this.sourceRevision = window.revision
    if (initial || !contiguous || window.change.kind === 'replace') {
      // A discontinuity cannot prove which tail entries were live. Rebaseline
      // conservatively, and invalidate any queue owned by the old source epoch.
      this.epoch = ++nextEpoch
      this.blocks.clear()
      this.liveSeqs.clear()
      this.liveMessages.clear()
      this.settlements.clear()
      this.consume(window.entries, false)
      this.ready = open || (!initial && window.change.kind === 'replace')
    } else if (window.change.kind === 'prepend') {
      // An older page must not reset the live tail or its queued prefix.
      this.consume(window.change.entries ?? [], false, true)
    } else if (window.change.kind === 'append') {
      this.consume(window.change.entries ?? [], this.ready)
    } else if (window.change.kind === 'settle-assistant') {
      this.settle(window.change.attemptId, window.change.entry)
    }
    // settle-assistant retires transient entries; their provenance must survive
    // the official durable handoff until this entry lifetime ends or is replaced.
    if (open) this.ready = true
    this.publish()
  }

  private consume(entries: readonly Entry[], live: boolean, preserve = false): void {
    for (const entry of entries) {
      const event = entry.event
      if (live) {
        this.liveSeqs.add(Number(event.seq))
        if (event.type === 'assistant/message' && event.surfaceOp === 'append') this.liveMessages.add(Number(event.seq))
      }
      if (event.type !== 'assistant/live-chunk') continue
      const data = event.data as ChunkData | null
      if (data === null || typeof data !== 'object' || typeof data.attemptId !== 'string'
        || typeof data.turn !== 'number' || typeof data.step !== 'number') continue
      const chunk = data.chunk
      if (chunk === undefined || typeof chunk.index !== 'number') continue
      const key = blockKey(data.turn, data.step, data.attemptId, chunk.index)
      const previous = this.blocks.get(key)
      if (preserve && previous !== undefined) continue
      const type = chunk.type
      if (type !== 'block-start' && type !== 'text-delta' && type !== 'reasoning-delta' && type !== 'block-end') continue
      const kind = type === 'block-start' ? chunk.blockType : type === 'block-end' ? chunk.block?.type
        : type === 'text-delta' ? 'text' : 'reasoning'
      if (typeof kind !== 'string') continue
      const reset = type === 'block-start' || previous === undefined || previous.kind !== kind
      const block: BlockLength = reset
        ? { seq: Number(event.seq), kind, length: 0, baseline: 0, live }
        : previous
      if (type === 'text-delta' || type === 'reasoning-delta') {
        if (typeof chunk.text !== 'string') continue
        block.length += chunk.text.length
        if (!live) block.baseline = block.length
      } else if (type === 'block-end' && typeof chunk.block?.text === 'string') {
        const length = chunk.block.text.length
        // A final block may correct token assembly. Unknown replacement content
        // is shown whole rather than borrowing a prefix from another generation.
        if (!live || length !== block.length) block.baseline = length
        block.length = length
      }
      block.live ||= live
      this.blocks.set(key, block)
    }
  }

  private settle(attemptId: string | undefined, entry: Entry | undefined): void {
    if (attemptId === undefined || entry?.event.type !== 'assistant/message') return
    const data = entry.event.data as { turn?: unknown; step?: unknown; message?: { content?: readonly { type: string }[] } } | null
    if (data === null || typeof data !== 'object' || typeof data.turn !== 'number' || typeof data.step !== 'number'
      || !Array.isArray(data.message?.content)) return
    const { turn, step } = data
    const blocks = [...this.blocks].flatMap(([key, block]) => {
      const [blockTurn, blockStep, attempt, index] = JSON.parse(key) as [number, number, string, number]
      return blockTurn === turn && blockStep === step && attempt === attemptId ? [{ index, block }] : []
    }).sort((left, right) => left.index - right.index)
    // An interrupted settlement can drop or replace blocks. Retain identities only
    // when the complete dense shape proves the wire mapping, never by text alone.
    if (blocks.length !== data.message.content.length || data.message.content.some((block, index) => block.type !== blocks[index]!.block.kind)) return
    this.settlements.set(JSON.stringify([turn, step, entry.event.seq]), blocks.map(({ index, block }) => ({
      turn, step, attemptId, blockIndex: index, blockSeq: block.seq,
    })))
  }

  settledBlock(turn: number, step: number, seq: number, index: number, kind: string): EntryBlockSource | undefined {
    this.refresh()
    const source = this.settlements.get(JSON.stringify([turn, step, seq]))?.[index]
    if (source?.attemptId === undefined || source.blockIndex === undefined) return undefined
    const block = this.blocks.get(blockKey(turn, step, source.attemptId, source.blockIndex))
    return block?.kind === kind && block.seq === source.blockSeq ? source : undefined
  }

  readBlock(source: EntryBlockSource, text: string): EntryBlockBaseline {
    this.refresh()
    const key = source.attemptId === undefined || source.blockIndex === undefined ? undefined
      : blockKey(source.turn, source.step, source.attemptId, source.blockIndex)
    const block = key === undefined ? undefined : this.blocks.get(key)
    const known = block !== undefined && source.blockSeq === block.seq
    const durable = source.blockSeq !== undefined && this.liveMessages.has(source.blockSeq)
    const animate = (known && block.live) || durable
    return {
      initialText: known && animate ? safePrefix(text, block.baseline) : durable ? '' : text,
      animate,
      generation: JSON.stringify([this.epoch, key, source.blockSeq]),
    }
  }

  isLiveSeq(seq: number): boolean {
    this.refresh()
    return this.liveSeqs.has(seq)
  }

  private publish(): void {
    this.revision++
    for (const listener of [...this.listeners]) listener()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe()
    this.listeners.clear()
    this.blocks.clear()
    this.liveSeqs.clear()
    this.liveMessages.clear()
    this.settlements.clear()
    observers.delete(this)
  }
}
