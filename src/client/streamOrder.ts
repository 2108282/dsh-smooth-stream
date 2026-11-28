import type { ConversationMatch, ConversationNodeDefinitionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'

export const STREAM_ORDER_DATA_KEY = 'dsh-smooth-stream/order' as const

/** Compare by identity: a replay/rebaseline creates a new token even for the same attempt. */
export interface StreamOrderRevision {
  readonly reason: 'start' | 'attempt' | 'retry' | 'settlement' | 'block-reset'
  readonly seq: number
}

export interface StreamOrderData {
  /** Keys are wire indices, NOT indices in the official compact node.data.blocks. */
  readonly blockSeqs: ReadonlyMap<number, number>
  /** Only an explicit block-end seals a live wire index. */
  readonly sealedBlocks: ReadonlySet<number>
  /** Official compact block index -> wire index; undefined when settlement changed its shape. */
  readonly blockIndices: readonly (number | undefined)[]
  readonly attemptId: string | undefined
  readonly revision: StreamOrderRevision
  readonly settled: boolean
  readonly settledSeq: number | undefined
}

export interface AlignedStreamOrder {
  /** All three arrays use the supplied node.data.blocks indices. */
  readonly blockIndices: readonly (number | undefined)[]
  readonly blockSeqs: readonly (number | undefined)[]
  readonly sealedBlocks: readonly boolean[]
  readonly attemptId: string | undefined
  readonly revision: StreamOrderRevision | undefined
}

interface StreamOrderState {
  readonly turn: number
  readonly step: number
  readonly data: StreamOrderData
  readonly blockKinds: ReadonlyMap<number, string>
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap {
    'dsh-smooth-stream/order': StreamOrderData
  }
}

/**
 * Read with node.location.step.data.get(STREAM_ORDER_DATA_KEY), then align against
 * the complete node.data.blocks before selecting reasoning/response group parts.
 * A settled/interrupted official node is durable boundary evidence even if this
 * Definition was registered late; an unknown running block remains unsealed.
 */
export function alignStreamOrder(
  data: StreamOrderData | undefined,
  blocks: readonly { readonly kind: string }[],
  status: 'running' | 'settled' | 'interrupted' = 'running',
): AlignedStreamOrder {
  const aligned = data?.blockIndices.length === blocks.length
  const settled = status !== 'running' || data?.settled === true
  const blockIndices = blocks.map((_, index) => aligned ? data?.blockIndices[index] : undefined)
  return {
    blockIndices,
    blockSeqs: blockIndices.map(index => index === undefined ? data?.settledSeq : data?.blockSeqs.get(index) ?? data?.settledSeq),
    sealedBlocks: blockIndices.map(index => settled || (index !== undefined && data?.sealedBlocks.has(index) === true)),
    attemptId: data?.attemptId,
    revision: data?.revision,
  }
}

function coordinates(match: ConversationMatch): { turn: number; step: number } | undefined {
  const location = match.location
  if (location.kind !== 'step') return undefined
  return { turn: location.step.turn, step: location.step.step }
}

// llm/retry is an optional plugin's declaration-merged event. Observe its
// verified runtime envelope without adding a dependency or redeclaring its type.
function retryCoordinates(event: ConversationMatch['event']): { turn: number; step: number } | undefined {
  if ((event.type as string) !== 'llm/retry') return undefined
  const data = event.data as { readonly turn?: unknown; readonly step?: unknown }
  return typeof data.turn === 'number' && typeof data.step === 'number'
    ? { turn: data.turn, step: data.step } : undefined
}

function initialData(match: ConversationMatch, reason: StreamOrderRevision['reason']): StreamOrderData {
  return {
    blockSeqs: new Map(),
    sealedBlocks: new Set(),
    blockIndices: [],
    attemptId: undefined,
    revision: { reason, seq: Number(match.event.seq) },
    settled: false,
    settledSeq: undefined,
  }
}

function resetState(state: StreamOrderState, match: ConversationMatch, reason: StreamOrderRevision['reason']): StreamOrderState {
  return { ...state, data: initialData(match, reason), blockKinds: new Map() }
}

function matchesStep(match: ConversationMatch, state: StreamOrderState): boolean {
  const value = coordinates(match)
  return value?.turn === state.turn && value.step === state.step
}

function assistantKind(type: string): string {
  return type === 'text' || type === 'reasoning' || type === 'tool-call' || type === 'image' ? type : 'other'
}

function settleMessage(state: StreamOrderState, match: ConversationMatch): StreamOrderState {
  if (match.event.type !== 'assistant/message') return state
  const content = match.event.data.message.content as readonly { type: string }[]
  const indices = state.data.blockIndices
  // An interrupted settlement may drop undispatched Tool calls. Never attach a
  // live raw index to a different dense content position in that case.
  const sameShape = indices.length === content.length && content.every((block, index) => {
    const raw = indices[index]
    return raw !== undefined && state.blockKinds.get(raw) === assistantKind(block.type)
  })
  return {
    ...state,
    data: {
      ...state.data,
      blockIndices: sameShape ? indices : content.map(() => undefined),
      settled: true,
      settledSeq: Number(match.event.seq),
    },
  }
}

function updateState(previous: StreamOrderState, match: ConversationMatch): StreamOrderState {
  if (!matchesStep(match, previous)) return previous
  const event = match.event
  // llm/retry clears the official Assistant state. assistant/attempt commits no
  // surface message: controller settlement normally removes its live Matches
  // and replays this Definition; handle direct updates without retaining seals.
  if (retryCoordinates(event) !== undefined) return resetState(previous, match, 'retry')
  if (event.type === 'assistant/attempt') return resetState(previous, match, 'settlement')
  if (event.type === 'assistant/message') return settleMessage(previous, match)
  if (event.type !== 'assistant/live-chunk') return previous

  let state = previous
  const attemptId = String(event.data.attemptId)
  if (state.data.attemptId !== attemptId) {
    // There is no synthetic "rebaseline" Session event. The Conversation
    // assembler invokes start again on replacement/replay, producing a fresh
    // revision token; a changed live attempt is an additional explicit reset.
    state = resetState(state, match, 'attempt')
    state = { ...state, data: { ...state.data, attemptId } }
  }
  const chunk = event.data.chunk
  if (chunk.type !== 'block-start' && chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta'
    && chunk.type !== 'tool-call-delta' && chunk.type !== 'block-end') return state
  const index = chunk.index
  const kind = chunk.type === 'block-start' ? (chunk.blockType === 'image' ? 'other' : assistantKind(chunk.blockType))
    : chunk.type === 'block-end' ? assistantKind(chunk.block.type)
      : chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'reasoning' : 'tool-call'
  const known = state.data.blockSeqs.has(index)
  const sealed = state.data.sealedBlocks.has(index)
  const ends = chunk.type === 'block-end'
  const restarts = known && (chunk.type === 'block-start' || (!ends && sealed)
    || state.blockKinds.get(index) !== kind)
  if (known && !restarts && sealed === ends) return state
  // Deltas in an existing open block change no metadata and return the same
  // state. Only a new index, explicit end, or explicit replacement copies maps.
  let blockSeqs = state.data.blockSeqs
  if (!known || chunk.type === 'block-start') {
    const next = new Map(blockSeqs)
    next.set(index, Number(event.seq))
    blockSeqs = next
  }
  let sealedBlocks = state.data.sealedBlocks
  if (sealed !== ends) {
    const next = new Set(sealedBlocks)
    if (ends) next.add(index)
    else next.delete(index)
    sealedBlocks = next
  }
  let blockKinds = state.blockKinds
  if (blockKinds.get(index) !== kind) {
    const next = new Map(blockKinds)
    next.set(index, kind)
    blockKinds = next
  }
  const blockIndices = known ? state.data.blockIndices : [...blockSeqs.keys()].sort((left, right) => left - right)
  return {
    ...state,
    blockKinds,
    data: {
      ...state.data,
      blockSeqs,
      sealedBlocks,
      blockIndices,
      revision: restarts ? { reason: 'block-reset', seq: Number(event.seq) } : state.data.revision,
    },
  }
}

export function streamOrderDefinition(): ConversationNodeDefinitionInput<StreamOrderState> {
  return {
    kind: STREAM_ORDER_DATA_KEY,
    match: event => {
      if (event.type === 'step/start') return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
      const retry = retryCoordinates(event)
      if (retry !== undefined) return { id: `${retry.turn}:${retry.step}`, role: 'update' }
      if (event.type === 'assistant/live-chunk' || event.type === 'assistant/attempt'
        || (event.type === 'assistant/message' && event.surfaceOp === 'append')) {
        return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
      }
      return null
    },
    start: (_context, match) => {
      const value = coordinates(match)
      if (value === undefined) throw new Error('stream order start outside a step')
      const state: StreamOrderState = { ...value, data: initialData(match, 'start'), blockKinds: new Map() }
      return updateState(state, match)
    },
    update: (context, match) => updateState(context.state, match),
    buildLocationData: (context, scope, previous) => {
      if (scope !== 'step' || context.state === undefined) return null
      if (previous?.key === STREAM_ORDER_DATA_KEY && previous.value === context.state.data) return previous
      return {
        kind: 'step',
        turn: context.state.turn,
        step: context.state.step,
        key: STREAM_ORDER_DATA_KEY,
        value: context.state.data,
      }
    },
  }
}
