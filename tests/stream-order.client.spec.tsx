import type {
  ConversationLocation, ConversationMatch, ConversationNodeDefinition, ConversationNodeDefinitionInput,
  ConversationViewDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { describe, expect, it, vi } from 'vitest'
import { alignStreamOrder, STREAM_ORDER_DATA_KEY, streamOrderDefinition, type StreamOrderData } from '../src/client/streamOrder.ts'

// Exercise the shipped assembler and Assistant definition, not a hand-built
// approximation of their compact blocks, settlement retirement, or replay.
interface Entry {
  readonly type: 'event' | 'transient'
  readonly event: ConversationMatch['event']
}
interface TestAssembler {
  replaceWindow(entries: readonly Entry[], hasMore: boolean): unknown
  append(entry: Entry): unknown
  settleAssistant(attemptId: string, entry?: Entry): unknown
  activateTarget(target: string): unknown
  flush(): unknown
  snapshot(target: string): unknown
}
interface TestNode extends ConversationViewNode {
  readonly location: ConversationLocation
  readonly data: {
    readonly blocks: readonly { readonly kind: string; readonly text?: string }[]
    readonly status: 'running' | 'settled' | 'interrupted'
  }
}
const { ConversationNodeAssembler } = await vi.importActual<{
  ConversationNodeAssembler: new (
    events: { entries: () => readonly ConversationNodeDefinition[]; fallbackEntry: () => undefined },
    views: { entries: () => readonly ConversationViewDefinition[] },
  ) => TestAssembler
}>('@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembler.ts')
const { assistantDefinition } = await vi.importActual<{ assistantDefinition: ConversationNodeDefinition }>(
  '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/assistant.ts')

function entry(type: string, seq: number, data: unknown, extras: Record<string, unknown> = {}): Entry {
  return {
    type: type === 'assistant/live-chunk' ? 'transient' : 'event',
    event: { type, seq, time: seq * 1000, data, ...extras } as ConversationMatch['event'],
  }
}
function chunk(seq: number, value: Record<string, unknown>, attemptId = 'attempt-a', step = 1): Entry {
  return entry('assistant/live-chunk', seq, { turn: 1, step, attemptId, chunk: value })
}
function message(seq: number, content: unknown[], interrupted = false, surfaceOp = 'append'): Entry {
  return entry('assistant/message', seq, {
    turn: 1, step: 1, message: { role: 'assistant', content }, stream: [],
    ...(interrupted ? { interrupted: true } : {}),
  }, { surfaceOp })
}
function definition(input = streamOrderDefinition()): ConversationNodeDefinition {
  // The production registration accepts function or keyed-table handlers. This
  // definition uses the function form; keep the test registry's types canonical.
  return input as unknown as ConversationNodeDefinition
}
function fixture(initial: readonly Entry[] = []) {
  let nodes: readonly ConversationViewNode[] = []
  const view: ConversationViewDefinition = {
    target: 'chat',
    create: () => ({
      empty: [],
      replace: input => { nodes = input.nodes; return nodes },
      apply: input => {
        const changed = new Map(nodes.map(node => [node.key, node]))
        for (const node of input.upserts) changed.set(node.key, node)
        nodes = [...changed.values()]
        return nodes
      },
    }),
  }
  const order = definition()
  const assembler = new ConversationNodeAssembler({
    entries: () => [order, assistantDefinition], fallbackEntry: () => undefined,
  }, { entries: () => [view] })
  const prefix = [entry('turn/start', 1, { turn: 1 }), entry('step/start', 2, { turn: 1, step: 1 })]
  assembler.replaceWindow([...prefix, ...initial], false)
  assembler.activateTarget('chat')
  assembler.flush()
  const node = (): TestNode => {
    const found = (assembler.snapshot('chat') as readonly TestNode[]).find(candidate => candidate.kind === 'assistant-step')
    if (found === undefined) throw new Error('expected official Assistant node')
    return found
  }
  const data = (): StreamOrderData => {
    const location = node().location
    const found = location.kind === 'step' ? location.step.data.get(STREAM_ORDER_DATA_KEY) : undefined
    if (found === undefined) throw new Error('expected Step-scoped stream order data')
    return found
  }
  return {
    assembler, prefix, node, data,
    append: (next: Entry) => { assembler.append(next); assembler.flush() },
    aligned: () => alignStreamOrder(data(), node().data.blocks, node().data.status),
  }
}

describe('stream order Conversation metadata', () => {
  it('maps sparse/out-of-order raw wire indices to the official compact blocks', () => {
    const f = fixture([chunk(2.5, { type: 'text-delta', index: 8, text: 'response' })])
    const open = f.data()
    expect(f.node().data.blocks).toEqual([{ kind: 'text', text: 'response' }])
    expect(f.aligned().blockIndices).toEqual([8])
    expect(f.aligned().blockSeqs).toEqual([2.5])
    expect(f.aligned().sealedBlocks).toEqual([false])
    f.append(chunk(2.6, { type: 'block-end', index: 8, block: { type: 'text', text: 'response' } }))
    const sealed = f.data()
    expect(sealed.blockSeqs).toBe(open.blockSeqs)
    expect(sealed.revision).toBe(open.revision)
    f.append(chunk(2.7, { type: 'reasoning-delta', index: 3, text: 'thought' }))
    expect(f.node().data.blocks.map(block => block.kind)).toEqual(['reasoning', 'text'])
    expect(f.aligned().blockIndices).toEqual([3, 8])
    expect(f.aligned().blockSeqs).toEqual([2.7, 2.5])
    expect(f.aligned().sealedBlocks).toEqual([false, true])
    expect(open.sealedBlocks.has(8)).toBe(false)
    expect(sealed.blockIndices).toEqual([8])
    expect(sealed.sealedBlocks.has(8)).toBe(true)
  })

  it('never infers a seal from a later block, finish/usage, or elapsed silence', () => {
    vi.useFakeTimers()
    try {
      const f = fixture([chunk(2.5, { type: 'text-delta', index: 0, text: 'first' })])
      f.append(chunk(2.6, { type: 'reasoning-delta', index: 4, text: 'later' }))
      const before = f.data()
      f.append(chunk(2.7, { type: 'finish', reason: 'stop' }))
      f.append(chunk(2.8, { type: 'usage', usage: {} }))
      vi.advanceTimersByTime(60_000)
      expect(f.data()).toBe(before)
      expect(f.aligned().sealedBlocks).toEqual([false, false])
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves metadata/maps/revision identity across ordinary token deltas', () => {
    const f = fixture([chunk(2.5, { type: 'block-start', index: 7, blockType: 'text' })])
    f.append(chunk(2.6, { type: 'text-delta', index: 7, text: 'first' }))
    const before = f.data()
    for (let index = 1; index <= 100; index++) {
      f.append(chunk(2.6 + index / 1000, { type: 'text-delta', index: 7, text: '.' }))
    }
    expect(f.data()).toBe(before)
    expect(f.aligned().blockSeqs).toEqual([2.5])
    expect(f.aligned().sealedBlocks).toEqual([false])
  })

  it('opens a reused index only on explicit replacement and issues a fresh revision', () => {
    const f = fixture([chunk(2.5, { type: 'block-end', index: 7, block: { type: 'text', text: 'old' } })])
    const old = f.data()
    f.append(chunk(2.6, { type: 'block-start', index: 7, blockType: 'text' }))
    expect(f.data().revision).not.toBe(old.revision)
    expect(f.data().revision.reason).toBe('block-reset')
    expect(f.aligned().sealedBlocks).toEqual([false])
    expect(f.aligned().blockSeqs).toEqual([2.6])
    expect(old.sealedBlocks.has(7)).toBe(true)
  })

  it('drops all prior-attempt seals/indices when the live attempt changes', () => {
    const f = fixture([chunk(2.5, { type: 'block-end', index: 7, block: { type: 'text', text: 'failed' } })])
    const before = f.data()
    // The actual controller retires attempt-a first. Direct event updates must
    // still not let its raw index 7 seal attempt-b's index 0.
    f.append(chunk(2.6, { type: 'text-delta', index: 0, text: 'retry' }, 'attempt-b'))
    expect(f.data().attemptId).toBe('attempt-b')
    expect(f.data().revision).not.toBe(before.revision)
    expect([...f.data().blockSeqs]).toEqual([[0, 2.6]])
    expect([...f.data().sealedBlocks]).toEqual([])
  })

  it('follows the official llm/retry reset and clears the abandoned block frontier', () => {
    const f = fixture([chunk(2.5, { type: 'block-end', index: 5, block: { type: 'text', text: 'failed' } })])
    const before = f.data()
    f.append(entry('llm/retry', 3, { turn: 1, step: 1 }))
    expect(f.node().data.blocks).toEqual([])
    expect(f.data().revision.reason).toBe('retry')
    expect(f.data().revision).not.toBe(before.revision)
    expect(f.data().attemptId).toBeUndefined()
    f.append(chunk(3.5, { type: 'text-delta', index: 0, text: 'new' }, 'attempt-b'))
    expect(f.aligned().blockIndices).toEqual([0])
    expect(f.aligned().sealedBlocks).toEqual([false])
  })

  it('uses actual attempt settlement retirement/replay without replaying its embedded failed stream', () => {
    const f = fixture([chunk(2.5, { type: 'block-end', index: 5, block: { type: 'text', text: 'failed' } })])
    const before = f.data()
    f.assembler.settleAssistant('attempt-a', entry('assistant/attempt', 3, {
      turn: 1, step: 1, stream: [{ type: 'text-chunks', time0: 1, index: 5, dt: [], texts: ['failed'] }],
    }))
    f.assembler.flush()
    expect(f.node().data.blocks).toEqual([])
    expect(f.data().revision).not.toBe(before.revision)
    expect(f.data().revision.reason).toBe('settlement')
    expect(f.data().settled).toBe(false)
    expect(f.data().blockSeqs.size).toBe(0)
    expect(f.data().sealedBlocks.size).toBe(0)
  })

  it('clears an abandoned attempt when the official controller retires it without settlement', () => {
    const f = fixture([chunk(2.5, { type: 'block-end', index: 5, block: { type: 'text', text: 'abandoned' } })])
    const before = f.data()
    f.assembler.settleAssistant('attempt-a')
    f.assembler.flush()
    expect(f.node().data.blocks).toEqual([])
    expect(f.data().revision).not.toBe(before.revision)
    expect(f.data().blockSeqs.size).toBe(0)
    expect(f.data().sealedBlocks.size).toBe(0)
  })

  it('gets a new revision and reconstructs only current evidence on rebaseline', () => {
    const live = chunk(2.5, { type: 'text-delta', index: 5, text: 'current' })
    const f = fixture([live, chunk(2.6, { type: 'block-end', index: 5, block: { type: 'text', text: 'current' } })])
    const before = f.data()
    f.assembler.replaceWindow([...f.prefix, live], false)
    f.assembler.flush()
    expect(f.data().attemptId).toBe(before.attemptId)
    expect(f.data().revision).not.toBe(before.revision)
    expect(f.aligned().sealedBlocks).toEqual([false])
    expect(before.sealedBlocks.has(5)).toBe(true)
  })

  it('uses durable message settlement as a seal fallback, preserving valid sparse order', () => {
    const f = fixture([
      chunk(2.5, { type: 'reasoning-delta', index: 3, text: 'thought' }),
      chunk(2.6, { type: 'text-delta', index: 8, text: 'answer' }),
    ])
    const before = f.data()
    f.append(message(3, [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'answer' }]))
    expect(f.aligned().sealedBlocks).toEqual([true, true])
    expect(f.aligned().blockIndices).toEqual([3, 8])
    expect(f.aligned().blockSeqs).toEqual([2.5, 2.6])
    expect(f.data().revision).toBe(before.revision)
    expect(before.settled).toBe(false)
  })

  it('does not misattach raw seals when an interrupted settlement drops Tool calls', () => {
    const f = fixture([
      chunk(2.5, { type: 'tool-call-delta', index: 2, id: 'not-dispatched', argumentsDelta: '', name: 'tool' }),
      chunk(2.6, { type: 'text-delta', index: 8, text: 'prefix' }),
    ])
    f.assembler.settleAssistant('attempt-a', message(3, [{ type: 'text', text: 'prefix' }], true))
    f.assembler.flush()
    expect(f.node().data.status).toBe('interrupted')
    expect(f.aligned().blockIndices).toEqual([undefined])
    expect(f.aligned().blockSeqs).toEqual([3])
    expect(f.aligned().sealedBlocks).toEqual([true])
  })

  it('supports settled-only history and explicit closed-boundary interrupted fallback', () => {
    const history = fixture([message(3, [{ type: 'text', text: 'historical' }])])
    expect(history.aligned().sealedBlocks).toEqual([true])
    expect(history.aligned().blockSeqs).toEqual([3])
    const interrupted = fixture([chunk(2.5, { type: 'text-delta', index: 8, text: 'prefix' })])
    interrupted.append(entry('step/end', 3, { turn: 1, step: 1 }))
    expect(interrupted.node().data.status).toBe('interrupted')
    expect(interrupted.data().settled).toBe(false)
    expect(interrupted.aligned().sealedBlocks).toEqual([true])
  })

  it('keeps a missing or mismatched running projection unsealed and allows final status fallback', () => {
    const blocks = [{ kind: 'text' }, { kind: 'reasoning' }]
    expect(alignStreamOrder(undefined, blocks).sealedBlocks).toEqual([false, false])
    expect(alignStreamOrder(undefined, blocks, 'settled').sealedBlocks).toEqual([true, true])
    const f = fixture([chunk(2.5, { type: 'block-end', index: 5, block: { type: 'text', text: 'one' } })])
    expect(alignStreamOrder(f.data(), blocks).blockSeqs).toEqual([undefined, undefined])
    expect(alignStreamOrder(f.data(), blocks).sealedBlocks).toEqual([false, false])
  })

  it('ignores non-append Assistant surface updates like the official definition', () => {
    const input: ConversationNodeDefinitionInput<unknown> = definition()
    expect(typeof input.match).toBe('function')
    if (typeof input.match !== 'function') throw new Error('expected match function')
    expect(input.match(message(3, [{ type: 'text', text: 'reset surface' }], false, 'replace').event)).toBeNull()
  })
})
