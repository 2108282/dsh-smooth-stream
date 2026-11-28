import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createElement, StrictMode, Suspense, useRef, useState, useSyncExternalStore,
  type ComponentType, type ReactElement, type ReactNode,
} from 'react'
import type { AssistantBlock, ChatConversationViewNode, ChatFlowSlotProps, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationMatch, ConversationNodeDefinition, ConversationViewDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPlaybackFlow, SessionPlaybackNode, useSessionPlayback } from '../src/client/sessionPlaybackReact.tsx'
import { installEntryBaselineSource, type EntryBaselineBinding, type EntryBaselineWindow } from '../src/client/entryBaseline.ts'
import * as followHost from '../src/client/FollowHost.tsx'
import type { SettingsSource } from '../src/client/flowPresentationAdapter.tsx'
import { apply, inject } from '../src/client/index.ts'
import { visibleReasoningText } from '../src/client/reasoningPlayback.ts'
import { DEFAULT_STREAM_SETTINGS, type StreamSettings } from '../src/settings.ts'
import { STREAM_ORDER_DATA_KEY, streamOrderDefinition, type StreamOrderData } from '../src/client/streamOrder.ts'

type SourceNode = ChatConversationViewNode
type AssistantOwner = ChatNodeViewProps<'assistant-step'>
type Entry = ChatFlowSlotProps['entries'][number]
type Group = NonNullable<ReturnType<ChatFlowSlotProps['useChatGroup']>>
type ProbeOwner = AssistantOwner & {
  children?: ReactNode
  renderSlot: (name: string, props: Record<string, unknown>) => ReactNode
}

let frames: Map<number, FrameRequestCallback>
let timestamp: number
let nextFrame: number
const baselineDisposers: (() => void)[] = []

beforeEach(() => {
  frames = new Map()
  timestamp = 0
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('performance', { now: () => timestamp })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  for (const dispose of baselineDisposers.splice(0).reverse()) dispose()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function paint(count = 1): Promise<void> {
  for (let index = 0; index < count; index++) await act(async () => {
    timestamp += 16
    const batch = [...frames.values()]
    frames.clear()
    for (const callback of batch) callback(timestamp)
  })
}

async function until(check: () => boolean, inspect: () => void = () => {}): Promise<void> {
  for (let index = 0; index < 1200 && !check(); index++) {
    await paint()
    inspect()
  }
  expect(check()).toBe(true)
}

function cell<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { value = next; for (const listener of [...listeners]) listener() },
  }
}

interface AssemblerEntry {
  readonly type: 'event' | 'transient'
  readonly event: ConversationMatch['event']
}
interface OfficialAssembler {
  replaceWindow(entries: readonly AssemblerEntry[], hasMore: boolean): unknown
  settleAssistant(attemptId: string, entry: AssemblerEntry): unknown
  activateTarget(target: string): unknown
  flush(): unknown
  snapshot(target: string): unknown
}
const { ConversationNodeAssembler } = await vi.importActual<{
  ConversationNodeAssembler: new (
    events: { entries: () => readonly ConversationNodeDefinition[]; fallbackEntry: () => undefined },
    views: { entries: () => readonly ConversationViewDefinition[] },
  ) => OfficialAssembler
}>('@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembler.ts')
const { assistantDefinition } = await vi.importActual<{ assistantDefinition: ConversationNodeDefinition }>(
  '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/assistant.ts')

/** Retirement must replay the shipped assembler, rather than append a durable event beside live chunks. */
function retiringAssistant(answer: string) {
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
  const order = streamOrderDefinition() as unknown as ConversationNodeDefinition
  const assembler = new ConversationNodeAssembler({
    entries: () => [order, assistantDefinition],
    fallbackEntry: () => undefined,
  }, { entries: () => [view] })
  const event = (type: string, seq: number, data: unknown, extras: Record<string, unknown> = {}): AssemblerEntry => ({
    type: type === 'assistant/live-chunk' ? 'transient' : 'event',
    event: { type, seq, time: seq * 1000, data, ...extras } as ConversationMatch['event'],
  })
  assembler.replaceWindow([
    event('turn/start', 1, { turn: 1 }),
    event('step/start', 2, { turn: 1, step: 1 }),
    event('assistant/live-chunk', 2.5, { turn: 1, step: 1, attemptId: 'retiring-attempt',
      chunk: { type: 'text-delta', index: 8, text: answer } }),
    event('assistant/live-chunk', 2.6, { turn: 1, step: 1, attemptId: 'retiring-attempt',
      chunk: { type: 'block-end', index: 8, block: { type: 'text', text: answer } } }),
  ], false)
  assembler.activateTarget('chat')
  assembler.flush()
  const node = (): SourceNode => {
    const value = (assembler.snapshot('chat') as readonly SourceNode[]).find(candidate => candidate.kind === 'assistant-step')
    if (value === undefined) throw new Error('expected an official Assistant node')
    return value
  }
  return {
    node,
    settle() {
      assembler.settleAssistant('retiring-attempt', event('assistant/message', 3, {
        turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: answer }] }, stream: [],
      }, { surfaceOp: 'append' }))
      assembler.flush()
      return node()
    },
  }
}

function assistant(key: string, text: string, options: {
  status?: 'running' | 'settled' | 'interrupted'; closed?: boolean; blocks?: AssistantBlock[]; sealed?: readonly boolean[]
  seqs?: readonly number[]; attempt?: string; wireIndices?: readonly number[]; anchorSeq?: number
  terminalReason?: 'error' | 'aborted' | 'interrupted'
} = {}): SourceNode {
  const blocks = options.blocks ?? [{ kind: 'text', text }]
  const anchorSeq = options.anchorSeq ?? Number(key.split(':').at(-1)) * 100
  const wireIndices = blocks.map((_, index) => options.wireIndices?.[index] ?? index)
  return {
    key, id: key, kind: 'assistant-step', anchorSeq,
    target: 'chat', visibility: 'visible',
    data: { status: options.status ?? 'settled', blocks, turn: 1, step: 1, time: 0 },
    location: {
      kind: 'step', turn: { turn: 1, status: options.closed ? 'closed' : 'open',
        ...(options.terminalReason === undefined ? {} : { end: { data: { reason: { kind: options.terminalReason } } } }) },
      step: { turn: 1, step: 1, status: options.closed ? 'closed' : 'open',
        data: new Map([[STREAM_ORDER_DATA_KEY, {
          blockSeqs: new Map(blocks.map((_, index) => [wireIndices[index]!, options.seqs?.[index] ?? anchorSeq + index])),
          sealedBlocks: new Set((options.sealed ?? []).flatMap((sealed, index) => sealed ? [wireIndices[index]!] : [])),
          blockIndices: wireIndices, attemptId: options.attempt ?? `${key}:attempt:1`,
          revision: { reason: 'start', seq: 1 }, settled: false, settledSeq: undefined,
        } satisfies StreamOrderData]]) },
    },
  } as unknown as SourceNode
}

function tool(key: string): SourceNode {
  return { key, id: key, kind: 'tool-call', anchorSeq: Number(key.split(':').at(-1)) * 100 + 50,
    data: { turn: 1, step: 1, status: 'settled', root: { callId: key, text: `complete ${key}` } },
    location: { kind: 'step', turn: { turn: 1, status: 'open' }, step: { turn: 1, step: 1, status: 'closed' } },
  } as unknown as SourceNode
}

function atomicCard(key: string, kind: 'context' | 'command' | 'system-prompt'): SourceNode {
  const anchorSeq = Number(key.split(':').at(-1)) * 100 + 50
  return {
    key, id: key, kind, anchorSeq, target: 'chat', visibility: 'visible',
    data: { turn: 1, step: 1, status: 'settled', root: { callId: key, text: `complete ${key}` } },
    location: { kind: 'step', turn: { turn: 1, status: 'open' }, step: { turn: 1, step: 1, status: 'closed' } },
  } as unknown as SourceNode
}

function entry(key: string, groupPart?: string): Entry {
  return { kind: 'node', key, ...(groupPart === undefined ? {} : { groupPart }) } as Entry
}

/** Only the shipped Inner renderers are replaced; all admission, projection and clocks are real. */
function fixture(options: { expanded?: boolean; strict?: boolean; ready?: boolean; markdown?: boolean; children?: boolean; cold?: boolean; managedKinds?: readonly string[]; settings?: Partial<StreamSettings> } = {}) {
  const source = cell(new Map<string, SourceNode>())
  let sessionId = 'single-clock-session'
  type WireEntry = EntryBaselineWindow['entries'][number]
  const windows = new Map<string, {
    session: ReturnType<typeof cell<{ openState: 'cold' | 'loading' | 'open' | 'error' }>>
    eventSource: ReturnType<typeof cell<EntryBaselineWindow>>
    nodes: readonly SourceNode[]
    seats: readonly Entry[]
  }>()
  const windowFor = (id: string) => {
    let value = windows.get(id)
    if (value === undefined) {
      value = { session: cell({ openState: options.cold ? 'cold' : 'open' }),
        eventSource: cell<EntryBaselineWindow>({ entries: [], revision: 0, change: { kind: 'replace', entries: [] } }),
        nodes: [], seats: [] }
      windows.set(id, value)
    }
    return value
  }
  const sessions = { binding: (id: string): EntryBaselineBinding => windowFor(id) }
  baselineDisposers.push(installEntryBaselineSource(sessions))
  const wireEvents = (values: readonly SourceNode[], previous: readonly SourceNode[]): WireEntry[] => {
    const events: WireEntry[] = []
    const emit = (type: string, seq: number, data: unknown) => events.push({
      type: type === 'assistant/live-chunk' ? 'transient' : 'event', event: { type, seq, data },
    })
    for (const node of values) {
      const prior = previous.find(candidate => candidate.key === node.key)
      if (node.kind !== 'assistant-step') {
        if (prior === undefined) emit('tool/call', node.anchorSeq, node.data)
        continue
      }
      if (node.location.kind !== 'step') continue
      const order = node.location.step.data.get(STREAM_ORDER_DATA_KEY) as StreamOrderData | undefined
      if (order?.attemptId === undefined) continue
      const oldOrder = prior?.location.kind === 'step'
        ? prior.location.step.data.get(STREAM_ORDER_DATA_KEY) as StreamOrderData | undefined : undefined
      const assistantNode = node as AssistantOwner['node']
      for (const [dense, block] of assistantNode.data.blocks.entries()) {
        if (block.kind !== 'text' && block.kind !== 'reasoning') continue
        const index = order.blockIndices[dense]!
        const seq = order.blockSeqs.get(index)!
        const oldDense = oldOrder?.attemptId === order.attemptId ? oldOrder.blockIndices.indexOf(index) ?? -1 : -1
        const oldBlock = prior?.kind === 'assistant-step' && oldDense >= 0
          ? (prior as AssistantOwner['node']).data.blocks[oldDense] : undefined
        const oldText = oldBlock?.kind === block.kind ? oldBlock.text : undefined
        const data = { turn: node.location.step.turn, step: node.location.step.step, attemptId: order.attemptId }
        const chunk = (part: unknown, offset: number) => emit('assistant/live-chunk', seq + offset, { ...data, chunk: part })
        if (oldText === undefined || !block.text.startsWith(oldText)) {
          chunk({ type: 'block-start', index, blockType: block.kind }, 0)
          chunk({ type: block.kind === 'text' ? 'text-delta' : 'reasoning-delta', index, text: block.text }, 0.0001)
        } else if (oldText !== block.text) {
          chunk({ type: block.kind === 'text' ? 'text-delta' : 'reasoning-delta', index, text: block.text.slice(oldText.length) }, 0.0001)
        }
        if (order.sealedBlocks.has(index) && (!oldOrder?.sealedBlocks.has(index) || oldText !== block.text)) {
          chunk({ type: 'block-end', index, block: { type: block.kind, text: block.text } }, 0.0002)
        }
      }
    }
    return events.sort((a, b) => a.event.seq - b.event.seq)
  }
  const groupSource = cell(new Map<string, Group>())
  let builder = { get: (key: string) => source.getSnapshot().get(key) }
  const chat = { nodes: builder }
  const preferences = cell<StreamSettings>({ ...DEFAULT_STREAM_SETTINGS, enabled: true, controlScroll: false, ...options.settings })
  const ready = cell(options.ready ?? true)
  const settings: SettingsSource = {
    getSnapshot: preferences.getSnapshot,
    takeoverEnabled: ready.getSnapshot,
    subscribe(listener) {
      const offPreferences = preferences.subscribe(listener)
      const offReady = ready.subscribe(listener)
      return () => { offPreferences(); offReady() }
    },
  }
  const seenNodes: ProbeOwner[] = []
  const seenFlows: ChatFlowSlotProps[] = []
  const mounts: string[] = []
  const child = createElement('small', { 'data-testid': 'official-child' }, 'official child')
  const slot = vi.fn((name: string, props: Record<string, unknown>) => name === 'conversation.chat.reasoning.body'
    ? renderText(String(props.text ?? ''), Boolean(props.running)) : null)
  const t = vi.fn((key: string) => `官方:${key}`)
  const labels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }
  const renderText = (text: string, running: boolean) => options.markdown
    ? createElement(MarkdownDelegateProvider, { openFile: extras.openFile,
      children: createElement(MarkdownText, { text, streaming: running, labels }) }) : text
  let entries: readonly Entry[] = []
  const useChatNode = ((key: string, selector: (node: SourceNode | undefined) => unknown = value => value) => {
    const node = useSyncExternalStore(source.subscribe, () => source.getSnapshot().get(key), () => source.getSnapshot().get(key))
    return selector(node)
  }) as ChatFlowSlotProps['useChatNode']
  const useChatGroup = ((key: string, selector: (group: Group | undefined) => unknown = value => value) => {
    const group = useSyncExternalStore(groupSource.subscribe, () => groupSource.getSnapshot().get(key), () => groupSource.getSnapshot().get(key))
    return selector(group)
  }) as ChatFlowSlotProps['useChatGroup']
  const useChat = ((selector: (snapshot: typeof chat) => unknown) => selector(chat)) as ChatFlowSlotProps['useChat']
  const useGroupAction: ChatFlowSlotProps['useGroupAction'] = () => useRef<HTMLDivElement>(null)
  const useDisclosure: AssistantOwner['useDisclosure'] = () => {
    const [expanded, setExpanded] = useState(options.expanded ?? true)
    return { expanded, setExpanded, toggle: () => setExpanded(value => !value) }
  }
  const ReasoningProbe = ({ props, text, index }: { props: ProbeOwner; text: string; index: number }) => {
    const disclosure = props.useDisclosure()
    const displayText = visibleReasoningText(text)
    const running = props.node.data.status === 'running' && index === props.node.data.blocks.length - 1
    const body = disclosure.expanded ? props.renderSlot('conversation.chat.reasoning.body', {
      rawText: text, text: displayText, running,
    }) : null
    const summary = displayText.split(/\r?\n/, 1)[0] ?? ''
    return createElement('section', null,
      createElement('button', { onClick: disclosure.toggle, 'aria-label': `toggle ${props.node.key}` }, props.t('message.think')),
      createElement('div', { 'data-block': index, hidden: !disclosure.expanded }, disclosure.expanded ? body : summary))
  }
  const NodeInner = (props: ProbeOwner) => {
    const { node } = props
    seenNodes.push(props)
    const [mounted] = useState(() => { mounts.push(node.key); return true })
    if (node.kind !== 'assistant-step') return createElement('aside', { 'data-node': node.key },
      createElement('svg', { 'data-card-icon': node.key }),
      createElement('header', null, `complete ${node.key}`),
      createElement('button', null, 'official action'))
    return createElement('article', { 'data-node': node.key, 'data-part': props.groupPart, 'data-status': node.data.status, 'data-mounted': String(mounted) },
      ...node.data.blocks.map((block, index) => {
        if (props.groupPart === 'reasoning' && block.kind !== 'reasoning') return null
        if (props.groupPart === 'response' && block.kind === 'reasoning') return null
        return block.kind === 'reasoning' && block.text.trim() !== ''
          ? createElement(ReasoningProbe, { key: index, props, text: block.text, index })
          : block.kind === 'text' ? createElement('div', { key: index, 'data-block': index }, renderText(block.text, node.data.status === 'running')) : null
      }), options.children === false ? null : props.children)
  }
  const WrappedNode = (props: ProbeOwner) => createElement(SessionPlaybackNode, { Inner: NodeInner, owner: props as never })
  let NodeRenderer: ComponentType<ProbeOwner> = WrappedNode
  function Seat({ flow, nodeKey, groupPart }: { flow: ChatFlowSlotProps; nodeKey: string; groupPart?: string | undefined }) {
    const node = flow.useChatNode(nodeKey, value => value)
    return node === undefined ? null : createElement(NodeRenderer, {
      node, groupPart, sessionId: flow.sessionId, useDisclosure, useGroupAction: flow.useGroupAction,
      renderSlot: flow.renderSlot, renderFactorySlot: flow.renderFactorySlot, t: flow.t,
      openFile: flow.openFile, forkAt: flow.forkAt, loadImage: flow.loadImage, inspectCall: undefined,
      useTurnData: () => undefined, children: child,
    } as unknown as ProbeOwner)
  }
  function GroupSeat({ flow, groupKey }: { flow: ChatFlowSlotProps; groupKey: string }) {
    const group = flow.useChatGroup(groupKey as never, value => value)
    return group === undefined ? null : createElement('section', { 'data-group': groupKey },
      createElement('header', null, groupKey),
      ...group.members.map(member => createElement(Seat, { key: `${member.key}:${member.groupPart ?? ''}`, flow, nodeKey: member.key, groupPart: member.groupPart })))
  }
  const FlowInner = (flow: ChatFlowSlotProps) => {
    seenFlows.push(flow)
    return createElement('main', null, ...flow.entries.map(item => item.kind === 'node'
      ? createElement(Seat, { key: `${item.key}:${item.groupPart ?? ''}`, flow, nodeKey: item.key, groupPart: item.groupPart })
      : createElement(GroupSeat, { key: item.key, flow, groupKey: item.key })))
  }
  const extras = { renderSlot: slot, renderFactorySlot: () => null, t,
    openFile: vi.fn(), forkAt: vi.fn(), loadImage: Object.assign(async () => '', { peek: () => undefined }) }
  function props(): ChatFlowSlotProps {
    return { sessionId, entries, useChatNode, useChatGroup, useChat, useGroupAction,
      useGroupHeaderAction: () => {}, ...extras } as unknown as ChatFlowSlotProps
  }
  let FlowRenderer: ComponentType<ChatFlowSlotProps> | undefined
  const managedNodeKinds = new Set(options.managedKinds ?? ['assistant-step', 'tool-call'])
  const tree = () => {
    const flow = FlowRenderer === undefined
      ? createElement(SessionPlaybackFlow, { Inner: FlowInner, props: props(), settings, managedNodeKinds })
      : createElement(FlowRenderer, props())
    return options.strict ? createElement(StrictMode, null, flow) : flow
  }
  return {
    tree, props, preferences, ready, seenNodes, seenFlows, mounts, slot, t, extras, FlowInner, NodeInner, sessions,
    replaceBuilder() {
      builder = { get: (key: string) => source.getSnapshot().get(key) }
      chat.nodes = builder
    },
    set(values: SourceNode[], nextEntries: readonly Entry[] = values.map(node => entry(node.key)),
      kind: EntryBaselineWindow['change']['kind'] = 'append') {
      const window = windowFor(sessionId)
      const previous = window.eventSource.getSnapshot()
      const additions = kind === 'replace' ? wireEvents(values, []) : wireEvents(values, window.nodes)
      const next = kind === 'replace' ? additions : kind === 'prepend'
        ? [...additions, ...previous.entries] : [...previous.entries, ...additions]
      window.nodes = values
      window.seats = nextEntries
      window.eventSource.set({ entries: next, revision: previous.revision + 1,
        change: { kind, entries: kind === 'settle-assistant' ? [] : additions } })
      entries = nextEntries
      source.set(new Map(values.map(node => [node.key, node])))
    },
    retire(attemptId: string, node: SourceNode, values: SourceNode[] = [node]) {
      if (node.kind !== 'assistant-step') throw new Error('expected durable Assistant')
      const assistantNode = node as AssistantOwner['node']
      const window = windowFor(sessionId)
      const previous = window.eventSource.getSnapshot()
      const order = node.location.kind === 'step' ? node.location.step.data.get(STREAM_ORDER_DATA_KEY) as StreamOrderData | undefined : undefined
      const durable: WireEntry = { type: 'event', event: { type: 'assistant/message', surfaceOp: 'append',
        seq: order?.settledSeq ?? node.anchorSeq,
        data: { turn: assistantNode.data.turn, step: assistantNode.data.step, message: { content: assistantNode.data.blocks.map(block => ({
          type: block.kind, ...('text' in block ? { text: block.text } : {}),
        })) } } } }
      const retained = previous.entries.filter(entry => (entry.event.data as { attemptId?: string }).attemptId !== attemptId)
      window.eventSource.set({ entries: [...retained, durable], revision: previous.revision + 1,
        change: { kind: 'settle-assistant', attemptId, entry: durable } })
      window.nodes = values
      window.seats = values.map(value => entry(value.key))
      entries = window.seats
      source.set(new Map(values.map(value => [value.key, value])))
    },
    open() { windowFor(sessionId).session.set({ openState: 'open' }) },
    switchSession(id: string) {
      sessionId = id
      const window = windowFor(id)
      entries = window.seats
      source.set(new Map(window.nodes.map(node => [node.key, node])))
    },
    group(key: string, members: (string | { key: string; groupPart: string })[]) {
      groupSource.set(new Map([[key, { key, data: { closed: false }, members: members.map(value => ({ kind: 'node', ...(typeof value === 'string' ? { key: value } : value) })) } as unknown as Group]]))
    },
    useRuntime(Flow: ComponentType<ChatFlowSlotProps>, Node: ComponentType<ProbeOwner>) { FlowRenderer = Flow; NodeRenderer = Node },
  }
}

function row(container: HTMLElement, key: string, groupPart?: string): HTMLElement | null {
  return container.querySelector(`[data-node="${key}"]${groupPart === undefined ? '' : `[data-part="${groupPart}"]`}`)
}
function text(container: HTMLElement, key: string, block = 0, groupPart?: string): string | undefined {
  return row(container, key, groupPart)?.querySelector(`[data-block="${block}"]`)?.textContent ?? undefined
}

describe('session playback injected into the official flow and keyed renderers', () => {
  it('keeps the same playback scope alive while Suspense temporarily hides the flow', async () => {
    const f = fixture()
    const settings: SettingsSource = {
      getSnapshot: () => DEFAULT_STREAM_SETTINGS,
      subscribe: () => () => {},
      takeoverEnabled: () => true,
    }
    const managedNodeKinds = new Set<string>()
    let suspended = false
    let resolveGate: () => void = () => {}
    const gate = new Promise<void>(resolve => { resolveGate = resolve })
    const captured: { scope: ReturnType<typeof useSessionPlayback> } = { scope: null }
    const FlowInner: ComponentType<ChatFlowSlotProps> = () => {
      captured.scope = useSessionPlayback()
      if (suspended) throw gate
      return createElement('output', null, 'flow resumed')
    }
    const FlowRenderer: ComponentType<ChatFlowSlotProps> = props => createElement(SessionPlaybackFlow, {
      Inner: FlowInner, props, settings, managedNodeKinds,
    })
    f.useRuntime(FlowRenderer, f.NodeInner)
    const tree = () => createElement(Suspense, { fallback: createElement('output', null, 'loading') }, f.tree())
    const view = render(tree())
    const playback = captured.scope?.playback
    expect(playback).toBeDefined()
    if (!playback) throw new Error('expected a playback scope')

    await act(async () => {
      suspended = true
      view.rerender(tree())
    })
    expect(view.getByText('loading')).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    playback.upsert('lifetime-check', [{ id: 'lifetime-check', order: [1], text: 'still alive', sealed: true }], false)
    playback.setEnabled(false)
    await act(async () => { await Promise.resolve() })
    expect(playback.read('lifetime-check').text).toBe('still alive')

    await act(async () => {
      suspended = false
      resolveGate()
      await Promise.resolve()
    })
    expect(view.getByText('flow resumed')).toBeTruthy()
    expect(captured.scope?.playback).toBe(playback)

    const resumedText = 'new text after Suspense recovery '.repeat(8)
    await act(async () => {
      playback.setEnabled(true)
      playback.upsert('after-resume', [{ id: 'after-resume', order: [2], text: resumedText, sealed: true }], true)
    })
    expect(playback.read('after-resume').text).not.toBe(resumedText)
    await paint(4)
    const prefix = playback.read('after-resume').text
    expect(prefix.length).toBeGreaterThan(0)
    expect(prefix.length).toBeLessThan(resumedText.length)
    expect(resumedText.startsWith(prefix)).toBe(true)
    await until(() => playback.read('after-resume').text === resumedText)

    view.unmount()
    await act(async () => { await Promise.resolve() })
    playback.upsert('after-unmount', [{ id: 'after-unmount', order: [3], text: 'disposed', sealed: true }], false)
    await act(async () => { await Promise.resolve() })
    expect(playback.read('after-unmount').text).toBe('')
  })

  it('serializes multiple assistant rows and admits each tool card and group atomically', async () => {
    const f = fixture()
    const view = render(f.tree())
    const first = 'first answer '.repeat(12)
    const second = 'second answer '.repeat(12)
    await act(async () => {
      f.group('process:1', ['tool:1'])
      f.set([assistant('assistant:1', first), tool('tool:1'), assistant('assistant:2', second), tool('tool:2')],
        [entry('assistant:1'), { kind: 'group', key: 'process:1' } as Entry, entry('assistant:2'), entry('tool:2')])
      view.rerender(f.tree())
    })
    expect(row(view.container, 'tool:1')).toBeNull()
    expect(view.container.querySelector('[data-group]')).toBeNull()
    let paced = false
    let pacedCardTitle = false
    let completedCardTitle = false
    await until(() => row(view.container, 'tool:2') !== null, () => {
      const prefix = text(view.container, 'assistant:1') ?? ''
      paced ||= prefix.length > 0 && prefix.length < first.length
      if (view.container.querySelector('[data-group]')) expect(prefix).toBe(first)
      if (row(view.container, 'tool:1')) {
        expect(prefix).toBe(first)
        expect(view.container.querySelector('[data-card-icon="tool:1"]')).not.toBeNull()
        const title = row(view.container, 'tool:1')?.querySelector('header')?.textContent ?? ''
        pacedCardTitle ||= title.length > 0 && title.length < 'complete tool:1'.length
        completedCardTitle ||= title === 'complete tool:1'
        expect(row(view.container, 'tool:1')?.querySelector('button')?.textContent).toBe('official action')
      }
      if (row(view.container, 'assistant:2')) {
        expect(row(view.container, 'tool:1')).not.toBeNull()
        expect(row(view.container, 'tool:1')?.querySelector('header')?.textContent).toBe('complete tool:1')
      }
      if (row(view.container, 'tool:2')) expect(text(view.container, 'assistant:2')).toBe(second)
    })
    expect(paced).toBe(true)
    expect(pacedCardTitle).toBe(true)
    expect(completedCardTitle).toBe(true)
    expect(f.mounts).toEqual(['assistant:1', 'tool:1', 'assistant:2', 'tool:2'])
  })

  it('streams context, command and system-prompt card text through the shared session queue', async () => {
    const f = fixture({ managedKinds: ['assistant-step', 'tool-call', 'context', 'command', 'system-prompt'] })
    const view = render(f.tree())
    const contextText = 'complete context:1'
    const commandText = 'complete command:2'
    await act(async () => {
      f.set([
        atomicCard('context:1', 'context'),
        atomicCard('command:2', 'command'),
        atomicCard('system-prompt:3', 'system-prompt'),
      ])
      view.rerender(f.tree())
    })

    let pacedContext = false
    let pacedCommand = false
    await until(() => row(view.container, 'system-prompt:3') !== null, () => {
      const context = row(view.container, 'context:1')?.querySelector('header')?.textContent ?? ''
      const command = row(view.container, 'command:2')?.querySelector('header')?.textContent ?? ''
      pacedContext ||= context.length > 0 && context.length < contextText.length
      pacedCommand ||= command.length > 0 && command.length < commandText.length
      if (row(view.container, 'command:2')) expect(context).toBe(contextText)
      if (row(view.container, 'system-prompt:3')) expect(command).toBe(commandText)
      expect(row(view.container, 'context:1')?.querySelector('button')?.textContent).toBe('official action')
    })
    expect(pacedContext).toBe(true)
    expect(pacedCommand).toBe(true)
    await until(() => row(view.container, 'system-prompt:3')?.querySelector('header')?.textContent === 'complete system-prompt:3')
  })

  it('admits the next tool card as soon as settled text drains without a fade tail', async () => {
    const f = fixture()
    const view = render(f.tree())
    const answer = 'short sealed answer'
    await act(async () => {
      f.set([assistant('assistant:1', answer, { status: 'settled', sealed: [true] }), tool('tool:1')])
      view.rerender(f.tree())
    })
    await until(() => text(view.container, 'assistant:1') === answer)
    expect(row(view.container, 'assistant:1')?.getAttribute('data-status')).toBe('settled')
    expect(row(view.container, 'tool:1')).not.toBeNull()
  })

  it('holds a drained live block through network silence until explicit block closure arrives', async () => {
    const f = fixture()
    const view = render(f.tree())
    const prefix = 'streaming prefix'
    const publish = async (value: string, sealed: boolean) => act(async () => {
      f.set([assistant('assistant:1', value, { status: 'running', sealed: [sealed] }), tool('tool:1')])
      view.rerender(f.tree())
    })
    await publish(prefix, false)
    await paint(240)
    expect(text(view.container, 'assistant:1')).toBe(prefix)
    expect(row(view.container, 'tool:1')).toBeNull()
    await publish(`${prefix} resumed after silence`, false)
    await paint(240)
    expect(text(view.container, 'assistant:1')).toBe(`${prefix} resumed after silence`)
    expect(row(view.container, 'tool:1')).toBeNull()
    await publish(`${prefix} resumed after silence`, true)
    await until(() => row(view.container, 'tool:1') !== null)
  })

  it.each(['text', 'reasoning'] as const)('keeps the %s source cursor and adopts the readable prefix when its visual group changes', async (kind: 'text' | 'reasoning') => {
    const f = fixture({ children: false, expanded: false, settings: { thinkAutoExpand: true } })
    const view = render(f.tree())
    const answer = kind === 'reasoning'
      ? `${'one source, one playback cursor '.repeat(20)}\n\ncontinued body`
      : 'one source, one playback cursor '.repeat(40)
    const part = kind === 'reasoning' ? 'reasoning' : 'response'
    const live = assistant('assistant:1', answer, { status: 'running', sealed: [false], blocks: [{ kind, text: answer }] })
    await act(async () => {
      f.set([live], [entry('assistant:1', part)])
      view.rerender(f.tree())
    })
    await paint(8)
    const before = text(view.container, 'assistant:1', 0, part) ?? ''
    expect(before.length).toBeGreaterThan(0)
    expect(before.length).toBeLessThan(answer.length)

    await act(async () => {
      f.set([live], [entry('assistant:1')])
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:1')).toBe(before)
    await paint(4)
    const after = text(view.container, 'assistant:1') ?? ''
    expect(after.startsWith(before)).toBe(true)
    expect(after.length).toBeGreaterThan(before.length)
    const output = row(view.container, 'assistant:1')!.querySelector('[data-block="0"]')!
    expect(output.textContent).toContain(after.slice(before.length, before.length + 4))
  })

  it.each([
    ['text', 'file'], ['reasoning', 'file'], ['text', 'reference'], ['reasoning', 'reference'],
  ] as const)('reparses a real %s Markdown %s link without replay and still paces a new suffix', async (kind: 'text' | 'reasoning', link: 'file' | 'reference') => {
    const f = fixture({ markdown: true, children: false, expanded: true, settings: { thinkAutoExpand: false } })
    const view = render(f.tree())
    const answer = link === 'file' ? 'read [source](</tmp/source.ts>)'
      : '[source][ref]\n\nsecond paragraph\n\nthird paragraph\n\n[ref]: https://example.test/source'
    const selector = link === 'file' ? 'button[title="/tmp/source.ts"]' : 'a[href="https://example.test/source"]'
    const publish = async (status: 'running' | 'settled', suffix = '') => act(async () => {
      f.set([assistant('assistant:1', '', { status, sealed: suffix ? [true, false] : [status === 'settled'],
        blocks: [{ kind, text: answer }, ...(suffix ? [{ kind, text: suffix }] : [])] })])
      view.rerender(f.tree())
    })
    await publish('running')
    await paint(240)
    const first = row(view.container, 'assistant:1')!
    expect(first.querySelector(selector)).toBeNull()
    if (link === 'reference') expect(text(view.container, 'assistant:1')).toContain(kind === 'reasoning' ? 'third paragraph' : '[source][ref]')
    await publish('settled')
    expect(row(view.container, 'assistant:1')).toBe(first)
    await until(() => first.querySelector(selector)?.textContent === 'source')
    const rendered = text(view.container, 'assistant:1')!
    const suffix = 'new suffix continues streaming '.repeat(10)
    await publish('running', suffix)
    expect(text(view.container, 'assistant:1')).toContain('source')
    expect(text(view.container, 'assistant:1', 1) ?? '').toBe('')
    await paint(4)
    const newPrefix = text(view.container, 'assistant:1', 1) ?? ''
    expect(newPrefix.length).toBeGreaterThan(0)
    expect(newPrefix.length).toBeLessThan(suffix.length)
    expect(suffix.startsWith(newPrefix)).toBe(true)
    await until(() => text(view.container, 'assistant:1', 1) === suffix.trimEnd())
    await publish('settled', suffix)
    await paint(20)
    expect(text(view.container, 'assistant:1')).toBe(rendered)
    expect(first.querySelectorAll(selector)).toHaveLength(1)
    expect(text(view.container, 'assistant:1', 1)).toBe(suffix.trimEnd())
  })

  it('does not replay paginated closed history or reset a live prefix under StrictMode', async () => {
    const f = fixture({ strict: true })
    const history = assistant('assistant:0', 'already read', { closed: true })
    f.set([history])
    const view = render(f.tree())
    await act(async () => {})
    expect(text(view.container, 'assistant:0')).toBe('already read')
    const live = assistant('assistant:1', 'live answer '.repeat(50), { status: 'running' })
    await act(async () => { f.set([history, live]); view.rerender(f.tree()) })
    await paint(8)
    const before = text(view.container, 'assistant:1') ?? ''
    const liveElement = row(view.container, 'assistant:1')
    expect(before.length).toBeGreaterThan(0)
    expect(before.length).toBeLessThan('live answer '.repeat(50).length)
    await act(async () => {
      f.set([assistant('assistant:-1', 'older page', { closed: true }), history, live], undefined, 'prepend')
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:-1')).toBe('older page')
    expect(text(view.container, 'assistant:0')).toBe('already read')
    expect(text(view.container, 'assistant:1')).toBe(before)
    expect(row(view.container, 'assistant:1')).toBe(liveElement)
    await paint(4)
    expect(text(view.container, 'assistant:1')!.startsWith(before)).toBe(true)
    expect(text(view.container, 'assistant:1')!.length).toBeGreaterThan(before.length)
  })

  it('shows the complete official output immediately on disable and does not replay it on re-enable', async () => {
    const f = fixture()
    const view = render(f.tree())
    const answer = 'pending answer '.repeat(40)
    const original = assistant('assistant:1', answer)
    await act(async () => { f.set([original, tool('tool:1')]); view.rerender(f.tree()) })
    await paint(5)
    expect(text(view.container, 'assistant:1')!.length).toBeLessThan(answer.length)
    await act(async () => { f.preferences.set({ ...f.preferences.getSnapshot(), enabled: false }) })
    expect(text(view.container, 'assistant:1')).toBe(answer)
    expect(row(view.container, 'tool:1')?.textContent).toBe('complete tool:1official action')
    const official = f.seenNodes.findLast(props => props.node.key === original.key)!
    expect(official.node).toBe(original)
    expect(official.renderSlot).toBe(f.slot)
    await act(async () => { f.preferences.set({ ...f.preferences.getSnapshot(), enabled: true }) })
    await paint(5)
    expect(text(view.container, 'assistant:1')).toBe(answer)
    expect(row(view.container, 'tool:1')).not.toBeNull()
  })

  it('keeps every native card and following assistant visible after disabling an unsealed live source and re-enabling', async () => {
    const f = fixture()
    const view = render(f.tree())
    const firstText = 'unsealed running source '.repeat(40)
    const followingText = 'following assistant already received '.repeat(30)
    const first = assistant('assistant:1', firstText, { status: 'running', sealed: [false] })
    const following = assistant('assistant:2', followingText, { sealed: [true] })
    const nodes = [first, tool('tool:1'), following, tool('tool:2')]
    await act(async () => { f.set(nodes); view.rerender(f.tree()) })
    await paint(8)
    const prefix = text(view.container, 'assistant:1')!
    expect(prefix.length).toBeGreaterThan(0)
    expect(prefix.length).toBeLessThan(firstText.length)
    expect(row(view.container, 'tool:1')).toBeNull()
    expect(row(view.container, 'assistant:2')).toBeNull()
    expect(row(view.container, 'tool:2')).toBeNull()
    const expectCompleteNativeOutput = () => {
      expect(text(view.container, 'assistant:1')).toBe(firstText)
      expect(row(view.container, 'tool:1')?.textContent).toBe('complete tool:1official action')
      expect(text(view.container, 'assistant:2')).toBe(followingText)
      expect(row(view.container, 'tool:2')?.textContent).toBe('complete tool:2official action')
    }
    await act(async () => { f.preferences.set({ ...f.preferences.getSnapshot(), enabled: false }) })
    expectCompleteNativeOutput()
    expect(f.seenNodes.findLast(props => props.node.key === first.key)?.node).toBe(first)
    expect(f.seenNodes.findLast(props => props.node.key === following.key)?.node).toBe(following)
    await act(async () => { f.preferences.set({ ...f.preferences.getSnapshot(), enabled: true }) })
    expectCompleteNativeOutput()
    for (let index = 0; index < 8; index++) {
      await paint()
      expectCompleteNativeOutput()
    }
    await act(async () => { f.set(nodes); view.rerender(f.tree()) })
    expectCompleteNativeOutput()
  })

  it.each([
    ['single-line', 'Thought', 'Thought'],
    ['later paragraph', 'First\n\nSecond\nmore', 'First'],
  ])('keeps a streaming non-tail reasoning summary native for %s blocks', async (_case: string, reasoning: string, summary: string) => {
    const f = fixture({ expanded: false, settings: { thinkAutoExpand: false } })
    const view = render(f.tree())
    const blocks: AssistantBlock[] = [
      { kind: 'reasoning', text: reasoning },
      { kind: 'text', text: 'answer follows reasoning' },
    ]
    await act(async () => {
      f.set([assistant('assistant:1', '', { status: 'running', blocks })])
      view.rerender(f.tree())
    })

    await until(() => text(view.container, 'assistant:1', 0) === summary)
    expect(text(view.container, 'assistant:1', 0)).toBe(summary)

    await act(async () => {
      f.set([assistant('assistant:1', '', { status: 'settled', blocks })])
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:1', 0)).toBe(summary)
  })

  it('keeps signature metadata out of the streamed reasoning Body Slot text', async () => {
    const f = fixture({ expanded: true, settings: { thinkAutoExpand: false } })
    const view = render(f.tree())
    const signature = '<signature>private metadata</signature>\n\n'
    const reasoning = `${signature}visible reasoning`
    await act(async () => {
      f.set([assistant('assistant:1', '', { status: 'running', blocks: [{ kind: 'reasoning', text: reasoning }] })])
      view.rerender(f.tree())
    })
    await paint(3)

    const slotCalls = f.slot.mock.calls as unknown as readonly (readonly [string, Record<string, unknown>])[]
    const latestBody = (): Record<string, unknown> | undefined => [...slotCalls].reverse()
      .find(call => call[0] === 'conversation.chat.reasoning.body')?.[1]
    expect(latestBody()).toMatchObject({ rawText: reasoning, text: '' })
    expect(view.container.textContent).not.toContain('private metadata')

    await until(() => latestBody()?.text === 'visible reasoning')
    expect(latestBody()).toMatchObject({ rawText: reasoning, text: 'visible reasoning' })
    const deliveredText = slotCalls.filter(call => call[0] === 'conversation.chat.reasoning.body')
      .map(call => String(call[1].text ?? ''))
    expect(deliveredText.every(value => !value.includes('<signature>') && !value.includes('private metadata'))).toBe(true)
    expect(view.container.textContent).not.toContain('private metadata')
  })

  it('keeps the official disclosure state and skips the remaining time of folded reasoning', async () => {
    const f = fixture({ expanded: true })
    const view = render(f.tree())
    const seed = 'reasoning already received'
    const leading: AssistantBlock = { kind: 'text', text: 'introduction' }
    await act(async () => {
      f.set([assistant('assistant:1', '', { status: 'running', sealed: [true, false], blocks: [
        leading, { kind: 'reasoning', text: seed },
      ] })])
      view.rerender(f.tree())
    })
    await until(() => text(view.container, 'assistant:1', 1) === seed)
    const thinking = seed + ' incoming reasoning '.repeat(500)
    await act(async () => {
      f.set([assistant('assistant:1', '', { status: 'running', sealed: [true, true, true], blocks: [
        leading, { kind: 'reasoning', text: thinking }, { kind: 'text', text: 'final answer' },
      ] })])
      view.rerender(f.tree())
    })
    await paint(8)
    expect(text(view.container, 'assistant:1', 1)!.length).toBeGreaterThan(seed.length)
    expect(text(view.container, 'assistant:1', 1)!.length).toBeLessThan(thinking.length)
    fireEvent.click(view.getByRole('button', { name: 'toggle assistant:1' }))
    await until(() => text(view.container, 'assistant:1', 2) === 'final answer')
    expect(row(view.container, 'assistant:1')?.querySelector('[data-block="1"]')?.hasAttribute('hidden')).toBe(true)
    fireEvent.click(view.getByRole('button', { name: 'toggle assistant:1' }))
    expect(text(view.container, 'assistant:1', 1)).toBe(thinking)
    expect(row(view.container, 'assistant:1')?.querySelector('[data-block="1"]')?.hasAttribute('hidden')).toBe(false)
  })

  it.each(['visibility', 'native'] as const)('keeps the ordinary queue moving across %s events and bounds a long frame gap', async (channel: 'visibility' | 'native') => {
    const f = fixture({ settings: {       debugTuningEnabled: true, debugTuning: { ...DEFAULT_STREAM_SETTINGS.debugTuning,
        revealScale: 1, maxRevealCps: 600, cadenceClamp: 4, queuePressure: 0.85 } } })
    const view = render(f.tree())
    const answer = 'ordinary queue before background events '.repeat(20)
    const publish = async (value: string, sealed = false) => act(async () => {
      f.set([assistant('assistant:1', value, { status: 'running', sealed: [sealed] }), tool('tool:1')])
      view.rerender(f.tree())
    })
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    const signal = async (hidden: boolean) => act(async () => {
      if (channel === 'visibility') {
        visibility.mockReturnValue(hidden ? 'hidden' : 'visible')
        document.dispatchEvent(new Event('visibilitychange'))
      } else window.dispatchEvent(new Event(hidden ? 'dsha:background' : 'dsha:foreground'))
    })
    await publish(answer)
    await paint(5)
    const prefix = text(view.container, 'assistant:1')!
    expect(prefix.length).toBeGreaterThan(0)
    expect(prefix.length).toBeLessThan(answer.length)
    await signal(true)
    const backlog = `${answer}${' appended through the same live source '.repeat(12)}`
    await publish(backlog)
    expect(text(view.container, 'assistant:1')).toBe(prefix)
    await paint(12)
    const hiddenProgress = text(view.container, 'assistant:1')!
    expect(hiddenProgress.startsWith(prefix)).toBe(true)
    expect(hiddenProgress.length).toBeGreaterThan(prefix.length)
    expect(hiddenProgress.length).toBeLessThan(backlog.length)
    expect(row(view.container, 'tool:1')).toBeNull()
    await signal(false)
    expect(text(view.container, 'assistant:1')).toBe(hiddenProgress)
    timestamp += 60_000
    await paint()
    const afterGap = text(view.container, 'assistant:1')!
    expect(afterGap.startsWith(hiddenProgress)).toBe(true)
    expect(afterGap.length - hiddenProgress.length).toBeGreaterThan(0)
    expect(afterGap.length - hiddenProgress.length).toBeLessThanOrEqual(4)
    expect(afterGap.length).toBeLessThan(backlog.length)
    await until(() => text(view.container, 'assistant:1') === backlog)
    expect(row(view.container, 'tool:1')).toBeNull()
    await publish(backlog, true)
    await until(() => row(view.container, 'tool:1') !== null)
  })

  it('interleaves two text blocks from the same assistant with the tool protocol event between them', async () => {
    const f = fixture()
    const view = render(f.tree())
    const first = 'first protocol block '.repeat(16)
    const second = 'second protocol block '.repeat(16)
    await act(async () => {
      f.set([assistant('assistant:1', '', { sealed: [true, true], seqs: [100, 300], blocks: [
        { kind: 'text', text: first }, { kind: 'text', text: second },
      ] }), tool('tool:1')])
      view.rerender(f.tree())
    })
    let firstPaced = false
    let secondPaced = false
    await until(() => text(view.container, 'assistant:1', 1) === second, () => {
      const a = text(view.container, 'assistant:1') ?? ''
      const b = text(view.container, 'assistant:1', 1) ?? ''
      firstPaced ||= a.length > 0 && a.length < first.length
      secondPaced ||= b.length > 0 && b.length < second.length
      if (a !== first) {
        expect(row(view.container, 'tool:1')).toBeNull()
        expect(b).toBe('')
      }
      if (row(view.container, 'tool:1')) expect(a).toBe(first)
      if (b !== '') expect(row(view.container, 'tool:1')).not.toBeNull()
    })
    expect(firstPaced).toBe(true)
    expect(secondPaced).toBe(true)
    expect(f.mounts).toEqual(['assistant:1', 'tool:1'])
  })

  it('uses protocol order when reasoning group members and response seats have different visual order', async () => {
    const f = fixture({ expanded: false, settings: { thinkAutoExpand: false } })
    const view = render(f.tree())
    const reasoning = `${'earliest protocol reasoning '.repeat(20)}\n\n`
    const summary = reasoning.slice(0, reasoning.indexOf('\n'))
    const response = 'last protocol response '.repeat(16)
    await act(async () => {
      f.group('process:1', ['tool:1', { key: 'assistant:1', groupPart: 'reasoning' }])
      f.set([assistant('assistant:1', '', { status: 'running', seqs: [100, 300], sealed: [true, true], blocks: [
        { kind: 'reasoning', text: reasoning }, { kind: 'text', text: response },
      ] }), tool('tool:1')], [entry('assistant:1', 'response'), { kind: 'group', key: 'process:1' } as Entry])
      view.rerender(f.tree())
    })
    let paced = false
    await until(() => text(view.container, 'assistant:1', 1, 'response') === response, () => {
      const visible = text(view.container, 'assistant:1', 0, 'reasoning') ?? ''
      paced ||= visible.length > 0 && visible.length < summary.length
      if (visible !== summary) {
        expect(text(view.container, 'assistant:1', 1, 'response') ?? '').toBe('')
      }
      if (row(view.container, 'tool:1')) expect(visible).toBe(summary)
      if ((text(view.container, 'assistant:1', 1, 'response') ?? '') !== '') {
        expect(row(view.container, 'tool:1')).not.toBeNull()
      }
    })
    expect(paced).toBe(true)
    expect(view.container.querySelector('[data-group="process:1"]')).not.toBeNull()
    // The response seat precedes the group in React's tree and may mount in
    // the same commit as the tool. The per-frame assertions above enforce
    // protocol admission without mistaking React's traversal for wire order.
    expect(f.mounts.filter(key => key === 'assistant:1')).toHaveLength(2)
    expect(f.mounts.filter(key => key === 'tool:1')).toHaveLength(1)
  })

  it('paces a first long reasoning block and keeps the native disclosures of two blocks independent', async () => {
    const f = fixture({ expanded: false, settings: { thinkAutoExpand: false } })
    const view = render(f.tree())
    const first = `${'first independent reasoning '.repeat(16)}\n\nfirst body continuation`
    const second = `${'second independent reasoning '.repeat(80)}\n\nsecond body continuation`
    await act(async () => {
      f.set([assistant('assistant:1', '', { status: 'running', sealed: [true, true, true], blocks: [
        { kind: 'reasoning', text: first }, { kind: 'reasoning', text: second }, { kind: 'text', text: 'final answer' },
      ] })])
      view.rerender(f.tree())
    })
    await paint(8)
    const firstPrefix = text(view.container, 'assistant:1')!
    expect(firstPrefix.length).toBeGreaterThan(0)
    expect(firstPrefix.length).toBeLessThan(first.length)
    expect(text(view.container, 'assistant:1', 1) ?? '').toBe('')
    await until(() => view.getAllByRole('button', { name: 'toggle assistant:1' }).length === 2)
    fireEvent.click(view.getAllByRole('button', { name: 'toggle assistant:1' })[1]!)
    await until(() => (text(view.container, 'assistant:1', 1) ?? '').length > 0)
    const secondPrefix = text(view.container, 'assistant:1', 1)!
    expect(secondPrefix.length).toBeLessThan(second.length)
    expect(row(view.container, 'assistant:1')?.querySelector('[data-block="0"]')?.hasAttribute('hidden')).toBe(true)
    expect(row(view.container, 'assistant:1')?.querySelector('[data-block="1"]')?.hasAttribute('hidden')).toBe(false)
    fireEvent.click(view.getAllByRole('button', { name: 'toggle assistant:1' })[0]!)
    expect(text(view.container, 'assistant:1')).toBe(first)
    expect(text(view.container, 'assistant:1', 1)).toBe(secondPrefix)
    expect(row(view.container, 'assistant:1')?.querySelector('[data-block="0"]')?.hasAttribute('hidden')).toBe(false)
    expect(row(view.container, 'assistant:1')?.querySelector('[data-block="1"]')?.hasAttribute('hidden')).toBe(false)
    fireEvent.click(view.getAllByRole('button', { name: 'toggle assistant:1' })[1]!)
    await until(() => text(view.container, 'assistant:1', 2) === 'final answer')
    expect(row(view.container, 'assistant:1')?.querySelector('[data-block="0"]')?.hasAttribute('hidden')).toBe(false)
    expect(row(view.container, 'assistant:1')?.querySelector('[data-block="1"]')?.hasAttribute('hidden')).toBe(true)
    fireEvent.click(view.getAllByRole('button', { name: 'toggle assistant:1' })[1]!)
    expect(text(view.container, 'assistant:1', 1)).toBe(second)
    expect(row(view.container, 'assistant:1')?.querySelector('[data-block="0"]')?.hasAttribute('hidden')).toBe(false)
    expect(row(view.container, 'assistant:1')?.querySelector('[data-block="1"]')?.hasAttribute('hidden')).toBe(false)
  })

  it('auto-expands a settled reasoning batch while its playback is still pending', async () => {
    const f = fixture({ expanded: false, settings: { thinkAutoExpand: true } })
    const view = render(f.tree())
    const reasoning = 'settled but not yet presented reasoning '.repeat(80)
    await act(async () => {
      f.set([assistant('assistant:1', '', { status: 'settled', sealed: [true], blocks: [
        { kind: 'reasoning', text: reasoning },
      ] })])
      view.rerender(f.tree())
    })
    await paint(8)
    const prefix = text(view.container, 'assistant:1')!
    expect(prefix.length).toBeGreaterThan(0)
    expect(prefix.length).toBeLessThan(reasoning.length)
    expect(row(view.container, 'assistant:1')?.querySelector('[data-block="0"]')?.hasAttribute('hidden')).toBe(false)
    expect(f.slot).toHaveBeenLastCalledWith('conversation.chat.reasoning.body', expect.objectContaining({
      rawText: reasoning, text: prefix, running: true,
    }))
    await paint(4)
    expect(text(view.container, 'assistant:1')!.startsWith(prefix)).toBe(true)
    expect(text(view.container, 'assistant:1')!.length).toBeGreaterThan(prefix.length)
    expect(text(view.container, 'assistant:1')!.length).toBeLessThan(reasoning.length)
  })

  it('keeps automatically opened reasoning and its progress unchanged by background signals', async () => {
    const f = fixture({ expanded: false, settings: { thinkAutoExpand: true } })
    const view = render(f.tree())
    const reasoning = 'automatically opened running reasoning '.repeat(80)
    const publish = async (value: string) => act(async () => {
      f.set([assistant('assistant:1', '', { status: 'running', blocks: [{ kind: 'reasoning', text: value }] })])
      view.rerender(f.tree())
    })
    const output = () => row(view.container, 'assistant:1')?.querySelector('[data-block="0"]')
    await publish(reasoning)
    await paint(8)
    const prefix = text(view.container, 'assistant:1')!
    expect(output()?.hasAttribute('hidden')).toBe(false)
    await act(async () => { window.dispatchEvent(new Event('dsha:background')) })
    const latest = `${reasoning}${' subsequent source chunks keep normal playback '.repeat(20)}`
    await publish(latest)
    expect(text(view.container, 'assistant:1')).toBe(prefix)
    await paint(8)
    const progressed = text(view.container, 'assistant:1')!
    expect(progressed.startsWith(prefix)).toBe(true)
    expect(progressed.length).toBeGreaterThan(prefix.length)
    await act(async () => { window.dispatchEvent(new Event('dsha:foreground')) })
    expect(output()?.hasAttribute('hidden')).toBe(false)
    expect(text(view.container, 'assistant:1')).toBe(progressed)
    for (let index = 0; index < 12; index++) {
      await paint()
      expect(output()?.hasAttribute('hidden')).toBe(false)
      expect(text(view.container, 'assistant:1')!.startsWith(progressed)).toBe(true)
    }
    expect(text(view.container, 'assistant:1')!.length).toBeGreaterThan(progressed.length)
    expect(text(view.container, 'assistant:1')!.length).toBeLessThan(latest.length)
  })

  it('preserves reveal progress when a sparse wire block moves to a different dense renderer index', async () => {
    const f = fixture()
    const view = render(f.tree())
    const answer = 'stable sparse wire text '.repeat(60)
    await act(async () => {
      f.set([assistant('assistant:1', answer, { status: 'running', wireIndices: [4], seqs: [104] }), tool('tool:1')])
      view.rerender(f.tree())
    })
    await paint(8)
    const prefix = text(view.container, 'assistant:1')!
    expect(prefix.length).toBeGreaterThan(0)
    expect(prefix.length).toBeLessThan(answer.length)
    await act(async () => {
      f.set([assistant('assistant:1', '', { status: 'running', wireIndices: [0, 4], seqs: [100, 104], sealed: [true, false], blocks: [
        { kind: 'text', text: '' }, { kind: 'text', text: answer },
      ] }), tool('tool:1')])
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:1', 1)).toBe(prefix)
    expect(text(view.container, 'assistant:1')).toBe('')
    expect(row(view.container, 'tool:1')).toBeNull()
    await paint(4)
    expect(text(view.container, 'assistant:1', 1)!.startsWith(prefix)).toBe(true)
    expect(text(view.container, 'assistant:1', 1)!.length).toBeGreaterThan(prefix.length)
    expect(text(view.container, 'assistant:1', 1)!.length).toBeLessThan(answer.length)
  })

  it('shows an initially mounted running prefix and existing tools immediately, then paces only appended text', async () => {
    const f = fixture({ settings: {  } })
    const history = assistant('assistant:0', 'existing closed history', { closed: true })
    const answer = 'initial running prefix '.repeat(24)
    const initial = assistant('assistant:1', answer, { status: 'running' })
    f.set([history, initial, tool('tool:1')])
    const view = render(f.tree())
    // The shared source ledger publishes in a microtask, before any animation frame.
    await act(async () => {})
    expect(text(view.container, 'assistant:0')).toBe('existing closed history')
    expect(text(view.container, 'assistant:1')).toBe(answer)
    expect(row(view.container, 'tool:1')).not.toBeNull()
    await paint(5)
    expect(text(view.container, 'assistant:1')).toBe(answer)
    const latest = `${answer}${'new live suffix '.repeat(30)}`
    await act(async () => {
      f.set([history, assistant('assistant:1', latest, { status: 'running' }), tool('tool:1'), tool('tool:2')])
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:1')).toBe(answer)
    expect(row(view.container, 'tool:1')).not.toBeNull()
    expect(row(view.container, 'tool:2')).toBeNull()
    await paint(8)
    const prefix = text(view.container, 'assistant:1')!
    expect(prefix.startsWith(answer)).toBe(true)
    expect(prefix.length).toBeGreaterThan(answer.length)
    expect(prefix.length).toBeLessThan(latest.length)
    await until(() => text(view.container, 'assistant:1') === latest)
    expect(row(view.container, 'tool:2')).toBeNull()
    await act(async () => {
      f.set([history, assistant('assistant:1', latest, { status: 'running', sealed: [true] }), tool('tool:1'), tool('tool:2')])
      view.rerender(f.tree())
    })
    await until(() => row(view.container, 'tool:2') !== null)
  })

  it('adopts a first cold history replacement that arrives after an empty mount, including running text and tools', async () => {
    const f = fixture({ cold: true, settings: {  } })
    const view = render(f.tree())
    expect(view.container.querySelector('[data-node]')).toBeNull()
    const existing = 'running history received after entry '.repeat(24)
    await act(async () => {
      f.set([assistant('assistant:1', existing, { status: 'running' }), tool('tool:1')], undefined, 'replace')
      f.open()
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:1')).toBe(existing)
    expect(row(view.container, 'tool:1')).not.toBeNull()
    await paint(8)
    expect(text(view.container, 'assistant:1')).toBe(existing)
    const latest = `${existing}${' live after cold load '.repeat(20)}`
    await act(async () => {
      f.set([assistant('assistant:1', latest, { status: 'running' }), tool('tool:1')])
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:1')).toBe(existing)
    await paint(8)
    expect(text(view.container, 'assistant:1')!.startsWith(existing)).toBe(true)
    expect(text(view.container, 'assistant:1')!.length).toBeGreaterThan(existing.length)
    expect(text(view.container, 'assistant:1')!.length).toBeLessThan(latest.length)
  })

  it('keeps a live suffix animated when the first cold baseline and append share one React commit', async () => {
    const f = fixture({ cold: true, settings: {  } })
    const view = render(f.tree())
    const baseline = 'baseline prefix before the same React commit '
    const latest = `${baseline}${'live suffix received before rendering '.repeat(30)}`
    await act(async () => {
      f.set([assistant('assistant:1', baseline, { status: 'running' }), tool('tool:1')], undefined, 'replace')
      f.open()
      f.set([assistant('assistant:1', latest, { status: 'running' }), tool('tool:1'), tool('tool:2')])
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:1')).toBe(baseline)
    expect(row(view.container, 'tool:1')).not.toBeNull()
    expect(row(view.container, 'tool:2')).toBeNull()
    await paint(8)
    const prefix = text(view.container, 'assistant:1')!
    expect(prefix.startsWith(baseline)).toBe(true)
    expect(prefix.length).toBeGreaterThan(baseline.length)
    expect(prefix.length).toBeLessThan(latest.length)
  })

  it('captures a fresh baseline when leaving A for B and returning to A', async () => {
    const f = fixture({ settings: {  } })
    const view = render(f.tree())
    const answer = 'session A queued before departure '.repeat(40)
    await act(async () => { f.set([assistant('assistant:1', answer, { status: 'running' })]); view.rerender(f.tree()) })
    await paint(8)
    expect(text(view.container, 'assistant:1')!.length).toBeLessThan(answer.length)
    await act(async () => {
      f.switchSession('session-B')
      f.set([assistant('assistant:2', 'session B existing output', { status: 'running' }), tool('tool:2')], undefined, 'replace')
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:2')).toBe('session B existing output')
    expect(row(view.container, 'tool:2')).not.toBeNull()
    await act(async () => { f.switchSession('single-clock-session'); view.rerender(f.tree()) })
    expect(text(view.container, 'assistant:1')).toBe(answer)
    const latest = `${answer}${' resumed A live suffix '.repeat(20)}`
    await act(async () => { f.set([assistant('assistant:1', latest, { status: 'running' })]); view.rerender(f.tree()) })
    expect(text(view.container, 'assistant:1')).toBe(answer)
    await paint(8)
    expect(text(view.container, 'assistant:1')!.length).toBeGreaterThan(answer.length)
    expect(text(view.container, 'assistant:1')!.length).toBeLessThan(latest.length)
  })

  it.each(['complete', 'prefix'] as const)('preserves %s playback through actual official attempt retirement and durable settlement', async (progress: 'complete' | 'prefix') => {
    const f = fixture({ settings: {  } })
    const view = render(f.tree())
    const answer = 'real official settlement should retain playback '.repeat(16)
    const official = retiringAssistant(answer)
    const live = official.node()
    const order = live.location.kind === 'step' ? live.location.step.data.get(STREAM_ORDER_DATA_KEY) : undefined
    expect(order?.blockIndices).toEqual([8])
    expect(order?.attemptId).toBe('retiring-attempt')
    await act(async () => { f.set([live, tool('tool:1')]); view.rerender(f.tree()) })
    if (progress === 'complete') await until(() => text(view.container, live.key) === answer)
    else await paint(8)
    const before = text(view.container, live.key)!
    expect(before.length).toBeGreaterThan(0)
    if (progress === 'prefix') {
      expect(before.length).toBeLessThan(answer.length)
      expect(row(view.container, 'tool:1')).toBeNull()
    } else expect(row(view.container, 'tool:1')).not.toBeNull()
    await act(async () => {
      const durable = official.settle()
      expect(durable.key).toBe(live.key)
      expect(durable.kind).toBe('assistant-step')
      expect((durable as AssistantOwner['node']).data.status).toBe('settled')
      f.set([durable, tool('tool:1')], undefined, 'settle-assistant')
      view.rerender(f.tree())
    })
    expect(text(view.container, live.key)).toBe(before)
    let previous = before.length
    for (let index = 0; index < 8; index++) {
      await paint()
      const current = text(view.container, live.key)!
      expect(current.startsWith(before)).toBe(true)
      expect(current.length).toBeGreaterThanOrEqual(previous)
      if (progress === 'complete') expect(current).toBe(answer)
      else {
        expect(current.length).toBeLessThan(answer.length)
        expect(row(view.container, 'tool:1')).toBeNull()
      }
      previous = current.length
    }
    if (progress === 'prefix') expect(previous).toBeGreaterThan(before.length)
    await until(() => text(view.container, live.key) === answer)
    expect(row(view.container, 'tool:1')).not.toBeNull()
  })

  it('paces an actual official attempt retired before React ever publishes its live node', async () => {
    const f = fixture({ settings: {  } })
    const view = render(f.tree())
    const answer = 'official coalesced retirement '.repeat(30)
    const official = retiringAssistant(answer)
    let key = ''
    await act(async () => {
      const live = official.node()
      key = live.key
      f.set([live])
      const durable = official.settle()
      f.retire('retiring-attempt', durable)
      view.rerender(f.tree())
    })
    expect(text(view.container, key) ?? '').toBe('')
    await paint(8)
    expect(text(view.container, key)!.length).toBeGreaterThan(0)
    expect(text(view.container, key)!.length).toBeLessThan(answer.length)
    await until(() => text(view.container, key) === answer)
  })

  it.each([false, true])('preserves a live suffix retired before its first React publication (existing prefix: %s)', async (existing: boolean) => {
    const f = fixture({ settings: {  } })
    const answer = 'coalesced official retirement '.repeat(30)
    const initial = existing ? 'already visible prefix ' : ''
    const live = assistant('assistant:1', initial, { status: 'running', wireIndices: [8], seqs: [100], attempt: 'coalesced' })
    if (existing) f.set([live])
    const view = render(f.tree())
    await act(async () => {})
    if (existing) expect(text(view.container, live.key)).toBe(initial)
    const final = `${initial}${answer}`
    await act(async () => {
      const running = assistant(live.key, final, { status: 'running', wireIndices: [8], seqs: [100], attempt: 'coalesced' }) as AssistantOwner['node']
      f.set([running])
      const durable = { ...running, data: { ...running.data, status: 'settled' }, location: {
        ...running.location, step: { ...(running.location as any).step, data: new Map([[STREAM_ORDER_DATA_KEY, {
          blockSeqs: new Map(), sealedBlocks: new Set(), blockIndices: [undefined], attemptId: undefined,
          revision: { reason: 'settlement', seq: 200 }, settled: true, settledSeq: 200,
        }]]) },
      } } as SourceNode
      f.retire('coalesced', durable)
      view.rerender(f.tree())
    })
    expect(text(view.container, live.key) ?? '').toBe(initial)
    await paint(8)
    const displayed = text(view.container, live.key)!
    expect(displayed.startsWith(initial)).toBe(true)
    expect(displayed.length).toBeGreaterThan(initial.length)
    expect(displayed.length).toBeLessThan(final.length)
    await until(() => text(view.container, live.key) === final)
  })

  it('restarts a same-prefix retry instead of carrying progress across attempt identities', async () => {
    const f = fixture()
    const view = render(f.tree())
    const answer = 'shared retry prefix '.repeat(50)
    await act(async () => {
      f.set([assistant('assistant:1', answer, { status: 'running', attempt: 'attempt:1' }), tool('tool:1')])
      view.rerender(f.tree())
    })
    await paint(10)
    const before = text(view.container, 'assistant:1')!
    expect(before.length).toBeGreaterThan(4)
    expect(before.length).toBeLessThan(answer.length)
    await act(async () => {
      f.set([assistant('assistant:1', `${answer} retry suffix`, { status: 'running', attempt: 'attempt:2' }), tool('tool:1')])
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:1') ?? '').toBe('')
    await paint(2)
    const after = text(view.container, 'assistant:1')!
    expect(after.length).toBeGreaterThan(0)
    expect(after.length).toBeLessThan(before.length)
    expect(before.startsWith(after)).toBe(true)
    expect(row(view.container, 'tool:1')).toBeNull()
  })

  it('does not fast-forward a live prefix when interrupted history is republished or paginated', async () => {
    const f = fixture({ settings: { thinkAutoExpand: false } })
    const old = assistant('assistant:0', 'cancelled old history', { closed: true, status: 'interrupted', terminalReason: 'aborted' })
    f.set([old])
    const view = render(f.tree())
    const answer = 'ongoing live answer '.repeat(60)
    const live = assistant('assistant:1', answer, { status: 'running' })
    await act(async () => { f.set([old, live, tool('tool:1')]); view.rerender(f.tree()) })
    await paint(8)
    const prefix = text(view.container, 'assistant:1')!
    expect(prefix.length).toBeGreaterThan(0)
    expect(prefix.length).toBeLessThan(answer.length)
    await act(async () => {
      f.set([assistant('assistant:-1', '', { closed: true, status: 'interrupted', terminalReason: 'interrupted', blocks: [
        { kind: 'reasoning', text: 'older interrupted reasoning' },
      ] }), assistant('assistant:0', 'cancelled old history updated', { closed: true, status: 'interrupted', terminalReason: 'error' }),
      live, tool('tool:1')], undefined, 'prepend')
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:-1')).toBe('older interrupted reasoning')
    expect(text(view.container, 'assistant:0')).toBe('cancelled old history updated')
    expect(text(view.container, 'assistant:1')).toBe(prefix)
    expect(row(view.container, 'tool:1')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'toggle assistant:-1' }))
    expect(text(view.container, 'assistant:1')).toBe(prefix)
    await paint(4)
    expect(text(view.container, 'assistant:1')!.startsWith(prefix)).toBe(true)
    expect(text(view.container, 'assistant:1')!.length).toBeGreaterThan(prefix.length)
    expect(text(view.container, 'assistant:1')!.length).toBeLessThan(answer.length)
    expect(row(view.container, 'tool:1')).toBeNull()
  })

  it('preserves the Inner renderer, children, locale, capabilities and untruncated reasoning rawText', async () => {
    const f = fixture({ expanded: true })
    const view = render(f.tree())
    const leading: AssistantBlock = { kind: 'text', text: 'leading text' }
    const seed = 'original reasoning'
    await act(async () => {
      f.set([assistant('assistant:1', '', { status: 'running', sealed: [true, false], blocks: [
        leading, { kind: 'reasoning', text: seed },
      ] })])
      view.rerender(f.tree())
    })
    await until(() => text(view.container, 'assistant:1', 1) === seed)
    const reasoning = seed + ' original reasoning '.repeat(50)
    const node = assistant('assistant:1', '', { status: 'running', sealed: [true, false], blocks: [
      leading, { kind: 'reasoning', text: reasoning },
    ] })
    await act(async () => { f.set([node]); view.rerender(f.tree()) })
    await paint(5)
    const displayed = text(view.container, 'assistant:1', 1)!
    expect(displayed.length).toBeGreaterThan(seed.length)
    expect(displayed.length).toBeLessThan(reasoning.length)
    const last = f.seenNodes.at(-1)!
    expect(last.t).toBe(f.t)
    expect(last.openFile).toBe(f.extras.openFile)
    expect(last.forkAt).toBe(f.extras.forkAt)
    expect(last.loadImage).toBe(f.extras.loadImage)
    expect(f.seenFlows.at(-1)?.renderSlot).toBe(f.slot)
    expect(view.getByTestId('official-child').textContent).toBe('official child')
    expect(view.getByRole('button', { name: 'toggle assistant:1' }).textContent).toBe('官方:message.think')
    expect(f.slot).toHaveBeenLastCalledWith('conversation.chat.reasoning.body', expect.objectContaining({
      rawText: reasoning, text: displayed, running: true,
    }))
    expect((node as AssistantOwner['node']).data.blocks[1]).toEqual({ kind: 'reasoning', text: reasoning })
  })

  it.each(['loading', 'pending'] as const)('keeps native output complete while settings are %s and adopts it without replay when ready', async (phase: 'loading' | 'pending') => {
    const f = fixture({ ready: false, settings: { enabled: phase === 'loading' } })
    const history = assistant('assistant:0', 'already loaded closed history', { closed: true })
    const answer = 'native text received before settings are ready '.repeat(12)
    f.set([history, assistant('assistant:1', answer, { status: 'running' }), tool('tool:1')])
    const view = render(f.tree())
    expect(text(view.container, 'assistant:0')).toBe('already loaded closed history')
    expect(text(view.container, 'assistant:1')).toBe(answer)
    expect(row(view.container, 'tool:1')).not.toBeNull()
    await paint(8)
    expect(text(view.container, 'assistant:1')).toBe(answer)

    const settled = assistant('assistant:1', `${answer} settled during settings initialization`)
    const previousTail = assistant('assistant:2', 'another complete native row')
    const loaded = [history, settled, tool('tool:1'), previousTail]
    await act(async () => {
      f.set(loaded)
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:1')).toBe(`${answer} settled during settings initialization`)
    expect(text(view.container, 'assistant:2')).toBe('another complete native row')
    const snapshotBeforeReady = f.preferences.getSnapshot()
    await act(async () => { f.ready.set(true) })
    // Ready is independently observable even when the preferences snapshot is unchanged.
    expect(f.preferences.getSnapshot()).toBe(snapshotBeforeReady)
    if (phase === 'pending') await act(async () => {
      f.preferences.set({ ...f.preferences.getSnapshot(), enabled: true })
    })
    const complete = `${answer} settled during settings initialization`
    for (let index = 0; index < 8; index++) {
      expect(text(view.container, 'assistant:0')).toBe('already loaded closed history')
      expect(text(view.container, 'assistant:1')).toBe(complete)
      expect(text(view.container, 'assistant:2')).toBe('another complete native row')
      expect(row(view.container, 'tool:1')).not.toBeNull()
      await paint()
    }

    const fresh = 'new text after settings become ready '.repeat(16)
    await act(async () => {
      f.set([...loaded, assistant('assistant:3', fresh, { status: 'running' })])
      view.rerender(f.tree())
    })
    await paint(8)
    expect(text(view.container, 'assistant:3')!.length).toBeGreaterThan(0)
    expect(text(view.container, 'assistant:3')!.length).toBeLessThan(fresh.length)
    expect(text(view.container, 'assistant:1')).toBe(complete)
  })

  it.each(['drained', 'setting-disabled'] as const)('folds only automatically opened reasoning when playback is %s', async (condition: 'drained' | 'setting-disabled') => {
    const f = fixture({ expanded: false, settings: { thinkAutoExpand: true } })
    const view = render(f.tree())
    const reasoning = 'reasoning that was opened only for playback '.repeat(16)
    await act(async () => {
      f.set([assistant('assistant:1', '', { sealed: [true], blocks: [{ kind: 'reasoning', text: reasoning }] })])
      view.rerender(f.tree())
    })
    const output = () => row(view.container, 'assistant:1')?.querySelector('[data-block="0"]')
    await paint(8)
    expect(output()?.hasAttribute('hidden')).toBe(false)
    expect(text(view.container, 'assistant:1')!.length).toBeGreaterThan(0)
    expect(text(view.container, 'assistant:1')!.length).toBeLessThan(reasoning.length)
    if (condition === 'drained') {
      await until(() => row(view.container, 'assistant:1')?.getAttribute('data-status') === 'settled')
    } else {
      await act(async () => {
        f.preferences.set({ ...f.preferences.getSnapshot(), thinkAutoExpand: false })
      })
    }
    expect(output()?.hasAttribute('hidden')).toBe(true)
    await paint(8)
    expect(output()?.hasAttribute('hidden')).toBe(true)
    expect(text(view.container, 'assistant:1')).toBe(reasoning)
  })

  it('preserves a manual reasoning expansion after playback drains and automatic expansion is disabled', async () => {
    const f = fixture({ expanded: false, settings: { thinkAutoExpand: true } })
    const view = render(f.tree())
    const reasoning = 'manually retained reasoning disclosure '.repeat(16)
    const publish = async (value: string) => act(async () => {
      f.set([assistant('assistant:1', '', { sealed: [true], blocks: [{ kind: 'reasoning', text: value }] })])
      view.rerender(f.tree())
    })
    const output = () => row(view.container, 'assistant:1')?.querySelector('[data-block="0"]')
    await publish(reasoning)
    await paint(8)
    expect(output()?.hasAttribute('hidden')).toBe(false)
    fireEvent.click(view.getByRole('button', { name: 'toggle assistant:1' }))
    expect(output()?.hasAttribute('hidden')).toBe(true)
    fireEvent.click(view.getByRole('button', { name: 'toggle assistant:1' }))
    expect(output()?.hasAttribute('hidden')).toBe(false)
    await until(() => text(view.container, 'assistant:1') === reasoning)
    await paint(8)
    expect(output()?.hasAttribute('hidden')).toBe(false)
    await act(async () => {
      f.preferences.set({ ...f.preferences.getSnapshot(), thinkAutoExpand: false })
    })
    expect(output()?.hasAttribute('hidden')).toBe(false)
    const appended = `${reasoning} later append after the user kept this disclosure open`
    await publish(appended)
    await until(() => text(view.container, 'assistant:1') === appended, () => {
      expect(output()?.hasAttribute('hidden')).toBe(false)
    })
  })

  it('keeps identical reasoning blocks independently folded when the closed block receives more text', async () => {
    const f = fixture({ settings: { thinkAutoExpand: false } })
    const view = render(f.tree())
    const shared = 'identical reasoning text in independently owned disclosures '.repeat(6)
    const publish = async (second: string, response = '') => act(async () => {
      f.set([assistant('assistant:1', '', { status: 'running', sealed: [true, true, true], blocks: [
        { kind: 'reasoning', text: shared }, { kind: 'reasoning', text: second }, { kind: 'text', text: response },
      ] })])
      view.rerender(f.tree())
    })
    const output = (index: number) => row(view.container, 'assistant:1')?.querySelector(`[data-block="${index}"]`)
    await publish(shared)
    await until(() => text(view.container, 'assistant:1', 1) === shared)
    expect(output(0)?.hasAttribute('hidden')).toBe(false)
    expect(output(1)?.hasAttribute('hidden')).toBe(false)
    fireEvent.click(view.getAllByRole('button', { name: 'toggle assistant:1' })[1]!)
    expect(output(0)?.hasAttribute('hidden')).toBe(false)
    expect(output(1)?.hasAttribute('hidden')).toBe(true)
    // This non-tail row follows native first-line summary semantics. Its hidden
    // body continuation consumes no queue budget while the response progresses.
    const appended = `${shared}\n\n${'hidden continuation must not borrow the other block disclosure '.repeat(40)}`
    const answer = 'visible response after the folded block '.repeat(12)
    await publish(appended, answer)
    await until(() => (text(view.container, 'assistant:1', 2) ?? '').length > 0, () => {
      expect(output(0)?.hasAttribute('hidden')).toBe(false)
      expect(output(1)?.hasAttribute('hidden')).toBe(true)
    })
    expect(text(view.container, 'assistant:1', 1)).toBe(shared)
    const slotCalls = f.slot.mock.calls as unknown as readonly (readonly [string, Record<string, unknown>])[]
    expect(slotCalls.some(call => call[0] === 'conversation.chat.reasoning.body' && call[1].rawText === appended)).toBe(false)
    expect(text(view.container, 'assistant:1', 2)!.length).toBeLessThan(answer.length)
    fireEvent.click(view.getAllByRole('button', { name: 'toggle assistant:1' })[0]!)
    expect(output(0)?.hasAttribute('hidden')).toBe(true)
    expect(output(1)?.hasAttribute('hidden')).toBe(true)
    fireEvent.click(view.getAllByRole('button', { name: 'toggle assistant:1' })[1]!)
    expect(output(0)?.hasAttribute('hidden')).toBe(true)
    expect(output(1)?.hasAttribute('hidden')).toBe(false)
  })

  it.each([true, false])('keeps protocol barriers and paces post-tool text when keepStreamOnToolCall=%s', async (keepStreamOnToolCall: boolean) => {
    const f = fixture({ settings: { keepStreamOnToolCall } })
    const view = render(f.tree())
    const before = 'text before the tool protocol boundary '.repeat(20)
    const after = 'text after the tool protocol boundary '.repeat(20)
    const publish = async (sealed: boolean) => act(async () => {
      f.set([assistant('assistant:1', '', { status: 'running', sealed: [sealed, true], seqs: [100, 200], blocks: [
        { kind: 'text', text: before }, { kind: 'text', text: after },
      ] }), tool('tool:1')])
      view.rerender(f.tree())
    })
    await publish(false)
    await paint(8)
    const prefix = text(view.container, 'assistant:1')!
    expect(prefix.length).toBeGreaterThan(0)
    if (keepStreamOnToolCall) expect(prefix.length).toBeLessThan(before.length)
    else expect(prefix).toBe(before)
    expect(row(view.container, 'tool:1')).toBeNull()
    expect(text(view.container, 'assistant:1', 1) ?? '').toBe('')
    await until(() => text(view.container, 'assistant:1') === before)
    await paint(20)
    expect(row(view.container, 'tool:1')).toBeNull()
    expect(text(view.container, 'assistant:1', 1) ?? '').toBe('')

    await publish(true)
    expect(text(view.container, 'assistant:1')).toBe(before)
    await until(() => (text(view.container, 'assistant:1', 1) ?? '').length > 0)
    expect(row(view.container, 'tool:1')).not.toBeNull()
    const suffixPrefix = text(view.container, 'assistant:1', 1)!
    expect(suffixPrefix.length).toBeLessThan(after.length)
    await paint(4)
    expect(text(view.container, 'assistant:1', 1)!.startsWith(suffixPrefix)).toBe(true)
    expect(text(view.container, 'assistant:1', 1)!.length).toBeGreaterThan(suffixPrefix.length)
    expect(text(view.container, 'assistant:1', 1)!.length).toBeLessThan(after.length)
  })

  it('does not adopt queued pre-tool text through an earlier unsealed head when tool-call smoothing is disabled', async () => {
    const f = fixture({ settings: { keepStreamOnToolCall: false } })
    const view = render(f.tree())
    const queued = 'queued text that can become immediate only at the head '.repeat(16)
    const head = (sealed: boolean) => assistant('assistant:0', 'open earlier head', {
      anchorSeq: 50, seqs: [50], status: 'running', sealed: [sealed],
    })
    const later = assistant('assistant:1', queued, { seqs: [100], sealed: [true] })
    await act(async () => {
      f.set([head(false), later, tool('tool:1')])
      view.rerender(f.tree())
    })
    await until(() => text(view.container, 'assistant:0') === 'open earlier head')
    await paint(20)
    expect(row(view.container, 'assistant:1')).toBeNull()
    expect(row(view.container, 'tool:1')).toBeNull()
    await act(async () => {
      f.set([head(true), later, tool('tool:1')])
      view.rerender(f.tree())
    })
    expect(text(view.container, 'assistant:1')).toBe(queued)
    await until(() => row(view.container, 'tool:1') !== null)
  })

  it('keeps atomic entrance gated until acknowledgement without reviving a retired entrance', async () => {
    type HostProps = Parameters<typeof followHost.FollowHost>[0]
    const gates = new Map<string, HostProps>()
    // This tests the real playback-to-FollowHost acknowledgement contract. The
    // geometric follower is replaced only so its completion signal is controlled.
    vi.spyOn(followHost, 'FollowHost').mockImplementation((props: HostProps) => {
      const child = props.children as ReactElement<{ node?: SourceNode }>
      const key = child.props.node?.key
      if (key !== undefined && props.onEntranceSettled !== undefined) gates.set(key, props)
      return createElement('div', { ref: props.hostRef }, props.children)
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 120, width: 300, height: 120,
      toJSON: () => ({}),
    })
    const port = document.createElement('div')
    port.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(port, 'clientHeight', { configurable: true, value: 500 })
    document.body.appendChild(port)
    const f = fixture({ settings: { controlScroll: true } })
    const view = render(f.tree(), { container: port })
    try {
      const answer = 'text after both native cards finish entering '.repeat(20)
      await act(async () => {
        f.set([tool('tool:1'), tool('tool:2'), assistant('assistant:3', answer)])
        view.rerender(f.tree())
      })
      expect(row(view.container, 'tool:1')).not.toBeNull()
      expect(gates.get('tool:1')?.entrance).toBe(true)
      expect(row(view.container, 'tool:2')).toBeNull()
      expect(row(view.container, 'assistant:3')).toBeNull()
      await paint(30)
      expect(row(view.container, 'tool:2')).toBeNull()
      expect(row(view.container, 'assistant:3')).toBeNull()
      const firstFinished = gates.get('tool:1')!.onEntranceSettled!
      await act(async () => { window.dispatchEvent(new Event('dsha:background')) })
      await paint(12)
      expect(gates.get('tool:1')?.entrance).toBe(true)
      expect(row(view.container, 'tool:2')).toBeNull()
      await act(async () => { window.dispatchEvent(new Event('dsha:foreground')) })
      expect(gates.get('tool:1')?.entrance).toBe(true)
      expect(row(view.container, 'assistant:3')).toBeNull()
      await act(async () => { firstFinished() })
      // The native card title follows its entrance in the same queue.
      await until(() => row(view.container, 'tool:2') !== null)
      expect(gates.get('tool:2')?.entrance).toBe(true)
      expect(row(view.container, 'assistant:3')).toBeNull()
      await act(async () => { firstFinished() })
      await paint(12)
      expect(row(view.container, 'assistant:3')).toBeNull()
      await act(async () => { gates.get('tool:2')!.onEntranceSettled!() })
      await until(() => (text(view.container, 'assistant:3') ?? '').length > 0)
      await paint(4)
      expect(text(view.container, 'assistant:3')!.length).toBeGreaterThan(0)
      expect(text(view.container, 'assistant:3')!.length).toBeLessThan(answer.length)
      expect(gates.get('tool:1')?.entrance).toBe(false)
      expect(gates.get('tool:2')?.entrance).toBe(false)
    } finally {
      view.unmount()
      port.remove()
    }
  })

  it('wraps actual runtime slot entries in place, handles late registration and restores officials on disposal', async () => {
    const f = fixture()
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.slots.register({ name: 'root', children: {
      'conversation.chat.flow': { kind: 'single', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    } } as never, () => null)
    ctx.slots.register({ name: 'conversation.chat.flow', priority: 20, children: {
      'official.flow.child': { kind: 'list', scope: 'session' },
    } } as never, f.FlowInner as never)
    ctx.slots.register({ name: 'conversation.chat.node', key: 'assistant-step', priority: 20,
      children: { 'official.assistant.child': { kind: 'list', scope: 'session' } } } as never, f.NodeInner as never)
    const flow = ctx.slots.entries('conversation.chat.flow')[0]!
    const node = ctx.slots.entries('conversation.chat.node')[0]!
    const flowOptions = flow.options
    const nodeOptions = node.options
    ctx.provide('sessions', f.sessions as never)
    const plugin = ctx.plugin({ inject: [...inject], apply })
    try {
      await plugin.await()
      expect(flow.component).not.toBe(f.FlowInner)
      expect(node.component).not.toBe(f.NodeInner)
      expect(flow.options).toBe(flowOptions)
      expect(node.options).toBe(nodeOptions)
      expect(flow.children).toBeDefined()
      expect(node.children).toBeDefined()
      f.useRuntime(flow.component as ComponentType<ChatFlowSlotProps>, node.component as ComponentType<ProbeOwner>)
      const view = render(f.tree())
      await act(async () => {
        f.set([assistant('assistant:1', 'official runtime answer')])
        view.rerender(f.tree())
      })
      await until(() => text(view.container, 'assistant:1') === 'official runtime answer')
      const Late = () => createElement('aside', null, 'late official tool')
      ctx.slots.register({ name: 'conversation.chat.node', key: 'tool-call' } as never, Late as never)
      await act(async () => { await Promise.resolve() })
      const late = ctx.slots.entries('conversation.chat.node').find(item => item.options.key === 'tool-call')!
      expect(late.component).not.toBe(Late)
      await act(async () => { plugin.dispose() })
      expect(flow.component).toBe(f.FlowInner)
      expect(node.component).toBe(f.NodeInner)
      expect(late.component).toBe(Late)
      expect(text(view.container, 'assistant:1')).toBe('official runtime answer')
    } finally {
      plugin.dispose()
    }
  })
})
