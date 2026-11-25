import type { ConversationMatch, ConversationNodeDefinitionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'

export const STREAM_ORDER_DATA_KEY = 'dsh-smooth-stream/order' as const

export interface StreamOrderData {
  readonly blockSeqs: ReadonlyMap<number, number>
}

interface StreamOrderState {
  readonly turn: number
  readonly step: number
  readonly blockSeqs: Map<number, number>
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap {
    'dsh-smooth-stream/order': StreamOrderData
  }
}

function coordinates(match: ConversationMatch): { turn: number; step: number } | undefined {
  const location = match.location
  if (location.kind !== 'step') return undefined
  return { turn: location.step.turn, step: location.step.step }
}

function eventBlockIndex(match: ConversationMatch): number | undefined {
  const event = match.event
  if (event.type !== 'assistant/live-chunk') return undefined
  const chunk = event.data.chunk
  if (chunk.type !== 'block-start' && chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta'
    && chunk.type !== 'tool-call-delta' && chunk.type !== 'block-end') return undefined
  return chunk.index
}

function matchesStep(match: ConversationMatch, state: StreamOrderState): boolean {
  const coordinatesValue = coordinates(match)
  return coordinatesValue?.turn === state.turn && coordinatesValue.step === state.step
}

function updateState(state: StreamOrderState, match: ConversationMatch): StreamOrderState {
  if (!matchesStep(match, state)) return state
  const index = eventBlockIndex(match)
  if (index === undefined || state.blockSeqs.has(index)) return state
  const next = new Map(state.blockSeqs)
  next.set(index, Number(match.event.seq))
  return { ...state, blockSeqs: next }
}

export function streamOrderDefinition(): ConversationNodeDefinitionInput<StreamOrderState> {
  return {
    kind: STREAM_ORDER_DATA_KEY,
    match: event => {
      if (event.type === 'step/start') return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
      if (event.type === 'assistant/live-chunk' || event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
      }
      return null
    },
    start: (_context, match) => {
      const coordinatesValue = coordinates(match)
      if (coordinatesValue === undefined) throw new Error('stream order start outside a step')
      const state: StreamOrderState = { ...coordinatesValue, blockSeqs: new Map() }
      return updateState(state, match)
    },
    update: (context, match) => updateState(context.state, match),
    buildLocationData: (context, scope) => {
      if (scope !== 'step' || context.state === undefined) return null
      return {
        kind: 'step',
        turn: context.state.turn,
        step: context.state.step,
        key: STREAM_ORDER_DATA_KEY,
        value: { blockSeqs: new Map(context.state.blockSeqs) } satisfies StreamOrderData,
      }
    },
  }
}
