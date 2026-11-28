import {
  createContext, createElement, Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect,
  useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode,
} from 'react'
import type { AssistantBlock, ChatFlowSlotProps, ChatNode, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { PRESET_CONFIG, type StreamSmoothingPreset } from './streamPresets.ts'
import type { SettingsSource } from './flowPresentationAdapter.tsx'
import { SessionPlayback, type PlaybackDisplay, type PlaybackSegment } from './sessionPlayback.ts'
import { createEntryBaseline, type EntryBaseline } from './entryBaseline.ts'
import { FollowHost } from './FollowHost.tsx'
import { usePlaybackDomText } from './usePlaybackDomText.ts'
import { reasoningSummary, reasoningPreviewProjection, visibleReasoningText } from './reasoningPlayback.ts'
import { debugRuntime } from './debugRuntime.ts'
import { notifyFollowCommit } from './teleprompterGlide.ts'
import { DEFAULT_STREAM_SETTINGS, DEFAULT_STREAM_DEBUG_TUNING, type StreamSettings } from '../settings.ts'
import { alignStreamOrder, STREAM_ORDER_DATA_KEY, type StreamOrderData } from './streamOrder.ts'

type RenderSlot = (name: string, props: Record<string, unknown>, ...args: unknown[]) => ReactNode
type AssistantProps = ChatNodeViewProps<'assistant-step'> & { renderSlot?: RenderSlot }
type NodeProps = { node?: unknown; sessionId?: unknown; groupPart?: string } & Record<string, unknown>
type SourceNode = ChatNode

function identity(key: string, part?: string): string { return JSON.stringify([key, part ?? '']) }
function sourceIdentity(owner: string, node: SourceNode | undefined): string {
  return typeof node?.key === 'string' ? node.key : owner
}
function segmentId(sourceKey: string, index: number | string): string { return JSON.stringify([sourceKey, index]) }
function summaryId(block: string): string { return `${block}:summary` }
interface PlaybackBlockIdentity {
  key: string
  seq: number
  generation: string
  attemptId: string | undefined
  wireIndex: number | undefined
}
interface SourceSegment extends PlaybackSegment { live: boolean }
function blockIds(scope: PlaybackScope, node: SourceNode): string[] {
  // Playback progress belongs to the source block, not to the renderer's
  // current visual partition (reasoning/response/grouped/ungrouped).
  return scope.blocks(node).map(block => segmentId(node.key, block.key))
}

/** One playback clock belongs to the injected Flow, never to a node renderer. */
export class PlaybackScope {
  readonly revealScale = { current: 1 }
  readonly playback = new SessionPlayback({
    requestFrame: callback => globalThis.requestAnimationFrame(time => {
      this.playback.setRevealScale(this.revealScale.current)
      callback(time)
    }),
  })
  preferences: StreamSettings = DEFAULT_STREAM_SETTINGS
  active = true
  speedCps = 110
  baselineRevision = 0
  readonly animatedOwners = new Set<string>()
  private readonly animations = new Map<string, ReadonlySet<string>>()
  private readonly animatedSegments = new Map<string, number>()
  private readonly tools = new Map<string, SourceNode>()
  private readonly orders = new Map<string, readonly number[]>()
  private revision = 0
  private readonly listeners = new Set<() => void>()
  private readonly flags = new Map<string, Map<string, boolean>>()
  private readonly registrations = new Map<string, symbol>()
  private readonly admittedBlocks = new Set<string>()
  private readonly blockIdentities = new Map<string, { node: SourceNode; blocks: readonly PlaybackBlockIdentity[] }>()
  constructor(readonly baseline: EntryBaseline) {}
  isAnimated(id: string): boolean { return this.animatedSegments.has(id) }
  hasAdmitted(id: string): boolean { return this.admittedBlocks.has(id) }
  admit(id: string): void {
    this.admittedBlocks.add(id)
    if (this.admittedBlocks.size > 2048) this.admittedBlocks.delete(this.admittedBlocks.values().next().value!)
  }
  cardOrder(owner: string): readonly number[] { return this.orders.get(owner) ?? [] }
  hasDisclosureState(id: string): boolean { return this.flag(`disclosure-known:${id}`) }
  reasoningCollapsed(id: string): boolean {
    return this.hasDisclosureState(id) ? !this.flag(`expanded:${id}`) : false
  }
  private setAnimations(owner: string, ids: ReadonlySet<string>): void {
    for (const id of this.animations.get(owner) ?? []) {
      const count = this.animatedSegments.get(id)! - 1
      if (count === 0) this.animatedSegments.delete(id)
      else this.animatedSegments.set(id, count)
    }
    this.animations.set(owner, ids)
    for (const id of ids) this.animatedSegments.set(id, (this.animatedSegments.get(id) ?? 0) + 1)
  }
  blocks(node: SourceNode): readonly PlaybackBlockIdentity[] {
    if (node.kind !== 'assistant-step') return []
    const previous = this.blockIdentities.get(node.key)
    if (previous?.node === node) return previous.blocks
    const metadata = node.location.kind === 'step'
      ? node.location.step.data.get(STREAM_ORDER_DATA_KEY) as StreamOrderData | undefined : undefined
    const aligned = alignStreamOrder(metadata, node.data.blocks, node.data.status)
    const used = new Set<number>()
    const previousBlocks = previous?.node.kind === 'assistant-step' ? previous.node.data.blocks : []
    const blocks = node.data.blocks.map((block, index) => {
      const settled = aligned.attemptId === undefined
        ? this.baseline.settledBlock(node.data.turn, node.data.step, aligned.blockSeqs[index] ?? node.anchorSeq, index, block.kind)
        : undefined
      if (settled !== undefined) return {
        key: `wire:${settled.blockIndex}`, seq: settled.blockSeq!,
        generation: JSON.stringify([settled.attemptId, settled.blockIndex, settled.blockSeq]),
        attemptId: settled.attemptId, wireIndex: settled.blockIndex,
      }
      // The official assembler retires live chunks on durable settlement. Its
      // final node keeps the key but no longer carries the wire/attempt mapping.
      // Retain a matching live block's presentation identity across that handoff.
      if (node.data.status !== 'running' && aligned.attemptId === undefined && previous !== undefined) {
        const matches = (candidate: AssistantBlock) => candidate.kind === block.kind
          && ((block.kind === 'text' || block.kind === 'reasoning')
            ? (candidate.kind === 'text' || candidate.kind === 'reasoning') && block.text.startsWith(candidate.text)
            : candidate === block)
        let prior = !used.has(index) && previousBlocks[index] !== undefined && matches(previousBlocks[index]!) ? index : -1
        if (prior === -1) prior = previousBlocks.findIndex((candidate, candidateIndex) => !used.has(candidateIndex) && matches(candidate))
        const retained = previous.blocks[prior]
        if (retained !== undefined) { used.add(prior); return retained }
      }
      const wire = aligned.blockIndices[index]
      return {
        key: wire === undefined ? `dense:${index}` : `wire:${wire}`,
        seq: aligned.blockSeqs[index] ?? node.anchorSeq,
        generation: JSON.stringify([aligned.attemptId, wire, metadata?.blockSeqs.get(wire ?? -1)]),
        attemptId: aligned.attemptId, wireIndex: wire,
      }
    })
    this.blockIdentities.set(node.key, { node, blocks })
    // Match the playback ledger's bounded retention for paginated history.
    if (this.blockIdentities.size > 2048) this.blockIdentities.delete(this.blockIdentities.keys().next().value!)
    return blocks
  }
  toolBoundary(node: SourceNode): number {
    const location = node.location
    if (location.kind !== 'step') return Number.POSITIVE_INFINITY
    let boundary = Number.POSITIVE_INFINITY
    for (const tool of this.tools.values()) {
      if (tool.location.kind === 'step' && tool.location.step.turn === location.step.turn
        && tool.location.step.step === location.step.step) boundary = Math.min(boundary, tool.anchorSeq)
    }
    return boundary
  }
  register(owner: string, segments: readonly SourceSegment[], node: SourceNode | undefined): void {
    const sourceKey = sourceIdentity(owner, node)
    if (node?.kind !== 'assistant-step' && segments[0] !== undefined) this.orders.set(owner, segments[0].order)
    const previousTool = this.tools.get(owner)
    if (node?.kind === 'tool-call') this.tools.set(owner, node)
    else this.tools.delete(owner)
    if ((previousTool?.anchorSeq ?? Infinity) !== (this.tools.get(owner)?.anchorSeq ?? Infinity)) this.publish()
    const location = node?.location
    const reason = location?.kind === 'turn' || location?.kind === 'step' ? location.turn.end?.data.reason.kind : undefined
    const interrupted = (node?.kind === 'assistant-step' && node.data.status === 'interrupted')
      || reason === 'error' || reason === 'aborted' || reason === 'interrupted'
    const animated = new Set(segments.filter(segment => segment.live && !interrupted).map(segment => segment.id))
    this.setAnimations(owner, animated)
    if (animated.size > 0) this.animatedOwners.add(sourceKey)
    else this.animatedOwners.delete(sourceKey)
    // Provenance, not running status or a renderer's mount time, admits new playback.
    this.playback.upsert(owner, segments, animated.size > 0)
  }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly snapshot = () => this.revision
  flag(key: string): boolean { return [...(this.flags.get(key)?.values() ?? [])].some(Boolean) }
  setFlag(key: string, token: string, value: boolean): () => void {
    const values = this.flags.get(key) ?? new Map<string, boolean>()
    const previous = this.flag(key)
    values.set(token, value)
    this.flags.set(key, values)
    if (previous !== this.flag(key)) this.publish()
    return () => {
      const before = this.flag(key)
      values.delete(token)
      if (values.size === 0) this.flags.delete(key)
      if (before !== this.flag(key)) this.publish()
    }
  }
  private publish() { this.revision++; for (const listener of [...this.listeners]) listener() }
  retain(owner: string): () => void {
    const token = Symbol(owner)
    this.registrations.set(owner, token)
    return () => {
      // StrictMode reattaches synchronously. Remove only truly departed sources.
      queueMicrotask(() => {
        if (this.registrations.get(owner) !== token) return
        this.registrations.delete(owner)
        this.setAnimations(owner, new Set())
        this.animations.delete(owner)
        this.orders.delete(owner)
        if (this.tools.delete(owner)) this.publish()
        this.playback.remove(owner)
      })
    }
  }
}

const PlaybackContext = createContext<{ scope: PlaybackScope; active: boolean } | null>(null)
export function useSessionPlayback(): PlaybackScope | null { return useContext(PlaybackContext)?.scope ?? null }

/** Determine closure only from the plugin projection or a durable assistant settlement. */
function sealedBlocks(node: NonNullable<SourceNode>): readonly boolean[] {
  if (node.kind !== 'assistant-step') return []
  if (node.data.status !== 'running') return node.data.blocks.map(() => true)
  const location = node.location
  const reason = location.kind === 'step' || location.kind === 'turn' ? location.turn.end?.data.reason.kind : undefined
  if (reason === 'error' || reason === 'aborted' || reason === 'interrupted') return node.data.blocks.map(() => true)
  const order = location.kind === 'step' ? location.step.data.get(STREAM_ORDER_DATA_KEY) as StreamOrderData | undefined : undefined
  return alignStreamOrder(order, node.data.blocks, node.data.status).sealedBlocks
}

function PlaybackNodeSource({ flow, scope, nodeKey, groupPart, order, groupKey, managedKinds }: {
  flow: ChatFlowSlotProps; scope: PlaybackScope; nodeKey: string; groupPart?: string | undefined
  order: readonly number[]; groupKey?: string | undefined; managedKinds: ReadonlySet<string>
}) {
  const node = flow.useChatNode(nodeKey, value => value) as SourceNode | undefined
  const controlRevision = useSyncExternalStore(scope.subscribe, scope.snapshot, scope.snapshot)
  const owner = identity(nodeKey, groupPart)
  const hidden = scope.flag(`hidden:${owner}`) || (groupKey !== undefined && scope.flag(`group:${groupKey}`))
  const shape = order.join(',')
  const segments = useMemo<readonly SourceSegment[]>(() => {
    if (node === undefined || !managedKinds.has(node.kind)) return []
    if (node.kind !== 'assistant-step') {
      const live = scope.baseline.isLiveSeq(node.anchorSeq)
      return [{ id: segmentId(nodeKey, -1), order: [node.anchorSeq, ...order, 0],
        text: '', sealed: true, hidden, live, ...(live ? {} : { baselineChars: 0 }),
        awaitPresentation: live }]
    }
    const sealed = sealedBlocks(node)
    const identities = scope.blocks(node)
    const ids = blockIds(scope, node)
    const toolBoundary = Math.min(scope.toolBoundary(node), ...node.data.blocks.flatMap((block, index) =>
      block.kind === 'tool-call' ? [identities[index]!.seq] : []))
    return node.data.blocks.flatMap((block, index) => {
      if (groupPart === 'reasoning' && block.kind !== 'reasoning') return []
      if (groupPart === 'response' && block.kind === 'reasoning') return []
      if (block.kind === 'tool-call') return []
      const blockIdentity = identities[index]!
      const text = block.kind === 'text' || block.kind === 'reasoning' ? block.text : ''
      const baseline = scope.baseline.readBlock({ turn: node.data.turn, step: node.data.step,
        attemptId: blockIdentity.attemptId, blockIndex: blockIdentity.wireIndex, blockSeq: blockIdentity.seq }, text)
      const id = ids[index]!
      const generation = JSON.stringify([blockIdentity.generation, baseline.generation])
      const suppressed = hidden || (!scope.preferences.keepStreamOnToolCall
        && blockIdentity.seq <= toolBoundary && toolBoundary !== Infinity)
      const reasoning = block.kind === 'reasoning'
      const reasoningRunning = reasoning && node.data.status === 'running' && index === node.data.blocks.length - 1
      const collapsed = reasoning && scope.reasoningCollapsed(id)
      const body: SourceSegment = { id, order: [blockIdentity.seq, ...order, index, 1],
        generation, live: baseline.animate,
        ...(!baseline.animate || baseline.initialText !== '' ? { baselineChars: Array.from(baseline.initialText).length } : {}),
        text, sealed: sealed[index] === true,
        hidden: suppressed || (reasoning && (collapsed || scope.flag(`reasoning-hidden:${owner}`))) }
      if (!reasoning) return [body]
      const summary = reasoningSummary(text, reasoningRunning)
      const initial = reasoningSummary(baseline.initialText, reasoningRunning)
      const baselineChars = !baseline.animate ? Array.from(summary.text).length
        : initial.paragraph === summary.paragraph ? Array.from(initial.text).length : 0
      return [{ id: summaryId(id), order: [blockIdentity.seq, ...order, index, 0],
        generation: JSON.stringify([generation, summary.paragraph]), live: baseline.animate,
        ...(baselineChars > 0 || !baseline.animate ? { baselineChars } : {}),
        text: summary.text, sealed: true,
        hidden: suppressed || (reasoning && ((scope.hasDisclosureState(id) && !collapsed) || scope.flag(`reasoning-hidden:${owner}`))) }, body]
    })
  }, [node, owner, shape, controlRevision, hidden, groupPart, managedKinds, scope,
    scope.preferences.thinkAutoExpand, scope.preferences.keepStreamOnToolCall, scope.baselineRevision])
  useLayoutEffect(() => scope.retain(owner), [scope, owner])
  useLayoutEffect(() => groupKey === undefined ? undefined
    : scope.setFlag(`unmanaged:${groupKey}`, owner, node !== undefined && !managedKinds.has(node.kind)),
  [scope, groupKey, owner, node?.kind, managedKinds])
  useEffect(() => { scope.register(owner, segments, node) }, [scope, owner, segments, node])
  return null
}

function PlaybackGroupSource({ flow, scope, groupKey, order, managedKinds }: {
  flow: ChatFlowSlotProps; scope: PlaybackScope; groupKey: Parameters<ChatFlowSlotProps['useChatGroup']>[0]
  order: readonly number[]; managedKinds: ReadonlySet<string>
}) {
  const group = flow.useChatGroup(groupKey, value => value)
  return createElement(Fragment, null, ...group?.members.map((member, index) => createElement(PlaybackNodeSource, {
    key: identity(member.key, member.groupPart), flow, scope, nodeKey: member.key, groupPart: member.groupPart,
    order: [...order, index], groupKey: String(groupKey), managedKinds,
  })) ?? [])
}

/** Original Hooks own disclosures and search/focus; observe only the refs they hand us. */
function useVisibilityHook(original: ChatFlowSlotProps['useGroupAction'], scope: PlaybackScope): ChatFlowSlotProps['useGroupAction'] {
  return useMemo(() => function usePlaybackVisibility(hidden, reveal) {
    const ref = original(hidden, reveal)
    const token = useId()
    useLayoutEffect(() => {
      const element = ref.current
      if (element === null) return
      const group = element.hasAttribute('data-chat-group-key') ? element
        : element.hasAttribute('data-step-process-body') ? element.closest<HTMLElement>('[data-chat-group-key]') : null
      if (group !== null) return scope.setFlag(`group:${group.dataset.chatGroupKey}`, token, hidden)
      const seat = element.closest<HTMLElement>('[data-chat-node-key]')
      if (seat?.dataset.chatNodeKey !== undefined) {
        const owner = identity(seat.dataset.chatNodeKey, seat.dataset.chatGroupPart)
        return scope.setFlag(`${element === seat ? 'hidden' : 'reasoning-hidden'}:${owner}`, token, hidden)
      }
    }, [hidden, ref, token])
    return ref
  }, [original, scope])
}

export function SessionPlaybackFlow({ Inner, props, settings, managedNodeKinds, preset = 'balanced' }: {
  Inner: ComponentType<ChatFlowSlotProps>; props: ChatFlowSlotProps; settings: SettingsSource; managedNodeKinds: ReadonlySet<string>
  preset?: StreamSmoothingPreset
}) {
  // A replaced builder is a synchronized window of the same session, not a
  // new playback owner. Session switches alone create a new presentation ledger.
  const builder = props.useChat(snapshot => snapshot.nodes)
  return createElement(SessionPlaybackFlowScope, { key: String(props.sessionId), Inner, props, settings, managedNodeKinds, builder, preset })
}

function SessionPlaybackFlowScope({ Inner, props, settings, managedNodeKinds, builder, preset }: {
  Inner: ComponentType<ChatFlowSlotProps>; props: ChatFlowSlotProps; settings: SettingsSource
  managedNodeKinds: ReadonlySet<string>; builder: unknown; preset: StreamSmoothingPreset
}) {
  const preferences = useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot)
  const runtimeTuning = useSyncExternalStore(debugRuntime.subscribe, debugRuntime.activeTuning, debugRuntime.activeTuning)
  const tuning = debugRuntime.getSnapshot().available ? runtimeTuning
    : preferences.debugTuningEnabled ? preferences.debugTuning : DEFAULT_STREAM_DEBUG_TUNING
  const baseline = useMemo(() => createEntryBaseline(String(props.sessionId)), [])
  const scope = useMemo(() => new PlaybackScope(baseline), [baseline])
  scope.baselineRevision = useSyncExternalStore(baseline.subscribe, baseline.getSnapshot, baseline.getSnapshot)
  scope.preferences = preferences
  const lifetime = useRef(0)
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const takeover = useCallback(() => settings.takeoverEnabled?.() ?? true, [settings])
  const ready = useSyncExternalStore(settings.subscribe, takeover, takeover)
  const active = ready && preferences.enabled && preferences.motionPreference !== 'force-reduced'
    && !(preferences.motionPreference === 'auto' && reduced)
  scope.active = active
  useLayoutEffect(() => {
    scope.speedCps = PRESET_CONFIG[preset].defaultCps * tuning.revealScale
    scope.playback.configure({ charsPerSecond: PRESET_CONFIG[preset].defaultCps, tuning })
    scope.playback.setEnabled(active)
  }, [scope, active, preset, tuning])
  // Suspense hiding cleans up layout effects but retains this scope. Only a
  // passive lifetime cleanup may dispose it; the generation guards StrictMode.
  useEffect(() => {
    const generation = ++lifetime.current
    return () => {
      queueMicrotask(() => {
        if (lifetime.current === generation) { scope.playback.dispose(); baseline.dispose() }
      })
    }
  }, [scope, baseline])
  const useGroupAction = useVisibilityHook(props.useGroupAction, scope)
  const useChatGroup = useMemo(() => function usePlaybackGroup(key: Parameters<ChatFlowSlotProps['useChatGroup']>[0], selector?: (value: unknown) => unknown) {
    const group = props.useChatGroup(key, value => value)
    useSyncExternalStore(scope.subscribe, scope.snapshot, scope.snapshot)
    const read = useCallback(() => group?.members.length === 0 || scope.flag(`unmanaged:${key}`) || (group?.members.some(member => {
      const node = builder === undefined ? undefined : (builder as { get(key: string): SourceNode | undefined }).get(member.key)
      if (node === undefined) return false
      if (!managedNodeKinds.has(node.kind)) return true
      const ids = blockIds(scope, node)
      return node.kind === 'assistant-step'
        ? node.data.blocks.some((block, index) => (member.groupPart === 'reasoning' ? block.kind === 'reasoning'
          : member.groupPart === 'response' ? block.kind !== 'reasoning' : true)
          && (scope.playback.read(ids[index]!).entered || (block.kind === 'reasoning'
             && scope.playback.read(summaryId(ids[index]!)).entered)))
        : scope.playback.read(segmentId(member.key, -1)).entered
    }) ?? false), [scope, group, builder, managedNodeKinds, key])
    const entered = useSyncExternalStore(scope.playback.subscribe, read, read)
    const admitted = useRef({ key, entered: false })
    if (admitted.current.key !== key) admitted.current = { key, entered: false }
    admitted.current.entered ||= entered
    const visible = !active || admitted.current.entered ? group : undefined
    return selector ? selector(visible) : visible
  }, [props.useChatGroup, scope, active, builder, managedNodeKinds])
  const sources = props.entries.map((entry, index) => entry.kind === 'node'
    ? createElement(PlaybackNodeSource, { key: identity(entry.key, entry.groupPart), flow: props, scope,
      nodeKey: entry.key, groupPart: entry.groupPart, order: [index, 0], managedKinds: managedNodeKinds })
    : createElement(PlaybackGroupSource, { key: `group:${entry.key}`, flow: props, scope,
      groupKey: entry.key, order: [index], managedKinds: managedNodeKinds }))
  return createElement(PlaybackContext.Provider, { value: { scope, active } }, ...sources,
    createElement(Inner, { ...props, key: 'official-flow', useGroupAction, useChatGroup: useChatGroup as ChatFlowSlotProps['useChatGroup'] }))
}

/** Wrap the shipped renderer, changing only its displayed data. No second Chat UI. */
export function SessionPlaybackNode({ Inner, owner }: { Inner: ComponentType<any>; owner: NodeProps }): ReactNode {
  const { scope, active } = useContext(PlaybackContext)!
  const node = owner.node as NonNullable<SourceNode> | undefined
  const sourceKey = String(node?.key)
  const ownerKey = identity(sourceKey, owner.groupPart)
  const ids = useMemo(() => {
    if (node?.kind !== 'assistant-step') return [segmentId(sourceKey, -1)]
    const all = blockIds(scope, node)
    return node.data.blocks.flatMap((block, index) => {
      if (owner.groupPart === 'reasoning' && block.kind !== 'reasoning') return []
      if (owner.groupPart === 'response' && block.kind === 'reasoning') return []
      return block.kind === 'tool-call' ? [] : block.kind === 'reasoning'
        ? [summaryId(all[index]!), all[index]!] : [all[index]!]
    })
  }, [node, owner.groupPart, sourceKey, scope])
  const previous = useRef<readonly PlaybackDisplay[]>([])
  const read = useCallback(() => {
    const next = ids.map(id => scope.playback.read(id))
    if (next.length !== previous.current.length || next.some((value, index) => value !== previous.current[index])) previous.current = next
    return previous.current
  }, [scope, ids])
  useSyncExternalStore(scope.playback.subscribe, read, read)
  useSyncExternalStore(scope.subscribe, scope.snapshot, scope.snapshot)
  if (!active) return createElement(Inner, owner)
  if (node?.kind !== 'assistant-step') {
    return scope.playback.read(segmentId(sourceKey, -1)).entered
      ? createElement(SessionPlaybackAtomic, { Inner, owner, scope, sourceKey }) : null
  }
  return createElement(SessionPlaybackAssistant, { Inner, owner: owner as unknown as AssistantProps, scope, ownerKey })
}

/** Native cards retain their elements; visible text shares the session clock. */
function SessionPlaybackAtomic({ Inner, owner, scope, sourceKey }: {
  Inner: ComponentType<any>; owner: NodeProps; scope: PlaybackScope; sourceKey: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const speed = useRef(scope.speedCps)
  speed.current = scope.speedCps
  const extent = useRef<number | null>(null)
  const id = segmentId(sourceKey, -1)
  const [entering, setEntering] = useState(() => scope.preferences.controlScroll && scope.animatedOwners.has(sourceKey) && scope.playback.read(id).pending)
  const revealInitial = useRef(scope.playback.read(id).pending)
  const [captured, setCaptured] = useState(false)
  const [textPending, setTextPending] = useState(false)
  const ready = useCallback(() => { setCaptured(true) }, [])
  const commit = useCallback(() => { notifyFollowCommit(root.current) }, [])
  const ownerKey = identity(sourceKey, owner.groupPart)
  const sourceOrder = scope.cardOrder(ownerKey)
  const orderKey = sourceOrder.join(',')
  const textOrder = useMemo(() => [...sourceOrder.slice(0, -1), 1], [orderKey])
  usePlaybackDomText(root, { playback: scope.playback, owner: `${ownerKey}:visible`, order: textOrder,
    animate: scope.isAnimated(id), enabled: scope.active, revealInitial: revealInitial.current,
    onReady: ready, onPendingChange: setTextPending, onCommit: commit })
  const finish = useCallback(() => {
    extent.current = null
    setEntering(false)
    scope.playback.acknowledgePresentation(id)
  }, [scope, id])
  const awaiting = scope.playback.read(id).pending
  useLayoutEffect(() => {
    if (!captured) return
    if (!awaiting) { extent.current = null; setEntering(false); return }
    const element = root.current
    const port = element?.closest<HTMLElement>('[data-conversation-scroll]')
    // No controlled scroll entrance exists without a measurable native port.
    // Release immediately instead of waiting for a callback that cannot arrive.
    if (!entering || !scope.preferences.controlScroll || !port?.isConnected || port.clientHeight <= 0
      || !element || element.getBoundingClientRect().height <= 0) finish()
  }, [scope, entering, awaiting, captured, scope.preferences.controlScroll, finish])
  const growth = useCallback((delta: number) => {
    if (!scope.preferences.controlScroll || !scope.playback.read(id).pending) return
    extent.current = (extent.current ?? 0) + delta
    setEntering(true)
    notifyFollowCommit(root.current)
  }, [scope, id])
  return createElement(FollowHost, {
    active: textPending, entrance: entering && scope.playback.read(id).pending,
    onEntranceSettled: finish, onGrowth: scope.preferences.controlScroll ? growth : undefined,
    entranceExtentRef: extent, speedCpsRef: speed, hostRef: root, revealScaleRef: scope.revealScale,
    predictive: false, controlScroll: scope.preferences.controlScroll,
    children: createElement(Inner, owner),
  })
}

function ReasoningBodyRegistration({ scope, keys, children }: { scope: PlaybackScope; keys: string; children: ReactNode }) {
  const token = useId()
  useLayoutEffect(() => {
    const off = (JSON.parse(keys) as string[]).map(key => scope.setFlag(`expanded:${key}`, token, true))
    return () => { for (const release of off) release() }
  }, [scope, keys, token])
  return createElement(Fragment, null, children)
}

function SessionPlaybackAssistant({ Inner, owner, scope, ownerKey }: {
  Inner: ComponentType<AssistantProps>; owner: AssistantProps; scope: PlaybackScope; ownerKey: string
}): ReactNode {
  const { node } = owner
  const root = useRef<HTMLDivElement>(null)
  const speed = useRef(scope.speedCps)
  speed.current = scope.speedCps
  const revealed = useRef(0)
  const ids = blockIds(scope, node)
  const disclosed = useRef(new Map<string, string>())
  const mountedReasoning = useRef<readonly string[]>([])
  const officialDisclosure = owner.useDisclosure
  const reasoningPending = node.data.blocks.some((block, index) => block.kind === 'reasoning'
    && scope.isAnimated(ids[index]!) && scope.playback.read(ids[index]!).pending)
  const useDisclosure = useMemo(() => function usePlaybackDisclosure() {
    const disclosure = officialDisclosure()
    const token = useId()
    const manual = useRef(false)
    const autoOpened = useRef(false)
    const autoExpand = !manual.current && scope.preferences.thinkAutoExpand && reasoningPending
    useLayoutEffect(() => {
      if (manual.current) return
      if (autoExpand && !disclosure.expanded) {
        autoOpened.current = true
        disclosure.setExpanded(true)
      } else if (!autoExpand && autoOpened.current) {
        autoOpened.current = false
        disclosure.setExpanded(false)
      }
    }, [disclosure.setExpanded, disclosure.expanded, autoExpand])
    useLayoutEffect(() => {
      // Each official ReasoningRow calls the same no-argument hook. Bind its
      // stable hook token to its mounted native block, not the whole owner.
      const assigned = new Set(disclosed.current.values())
      const id = mountedReasoning.current.find(key => !assigned.has(key))
      if (id === undefined) return
      disclosed.current.set(token, id)
      const release = scope.setFlag(`disclosure-known:${id}`, token, !autoExpand || disclosure.expanded)
      const releaseExpanded = scope.setFlag(`expanded:${id}`, token, disclosure.expanded)
      return () => { disclosed.current.delete(token); release(); releaseExpanded() }
    }, [scope, token, disclosure.expanded, autoExpand])
    return { ...disclosure,
      setExpanded: (value: boolean) => { manual.current = true; autoOpened.current = false; disclosure.setExpanded(value) },
      toggle: () => { manual.current = true; autoOpened.current = false; disclosure.toggle() },
    }
  }, [officialDisclosure, ownerKey, scope, reasoningPending])
  const projected: AssistantBlock[] = []
  let pending = false
  let entered = false
  for (const [index, block] of node.data.blocks.entries()) {
    const relevant = owner.groupPart === 'reasoning' ? block.kind === 'reasoning'
      : owner.groupPart === 'response' ? block.kind !== 'reasoning' : true
    if (!relevant || block.kind === 'tool-call') { projected.push(block); continue }
    const id = ids[index]!
    const display = scope.playback.read(id)
    const summary = block.kind === 'reasoning' ? scope.playback.read(summaryId(id)) : undefined
    if (display.entered || summary?.entered === true) scope.admit(id)
    const admitted = scope.hasAdmitted(id) || display.entered || summary?.entered === true
    pending ||= scope.isAnimated(id) && display.pending
    pending ||= summary !== undefined && scope.isAnimated(summaryId(id)) && summary.pending
    entered ||= admitted
    const collapsed = block.kind === 'reasoning' && (!scope.hasDisclosureState(id) || scope.reasoningCollapsed(id))
    const summaryText = block.kind === 'reasoning'
      ? reasoningPreviewProjection(summary?.text ?? '', block.text) : ''
    const text = block.kind !== 'reasoning' ? display.text
      : collapsed ? summaryText
        : display.text !== '' ? display.text
          : admitted ? `<signature>${id}</signature>\u200B` : ''
    projected.push(!admitted ? { kind: 'text', text: '' }
      : block.kind === 'text' || block.kind === 'reasoning' ? { ...block, text } : block)
  }
  mountedReasoning.current = projected.flatMap((block, index) => block.kind === 'reasoning' && block.text.trim() !== ''
    && (owner.groupPart === undefined || owner.groupPart === 'reasoning') ? [ids[index]!] : [])
  const displayedLength = projected.reduce((sum, block) => sum + (block.kind === 'text' || block.kind === 'reasoning' ? block.text.length : 0), 0)
  useLayoutEffect(() => {
    revealed.current = displayedLength
    if (pending) notifyFollowCommit(root.current)
  }, [displayedLength, pending])
  const renderSlot = useMemo(() => {
    if (owner.renderSlot === undefined) return undefined
    const render = owner.renderSlot
    const raw = new Map<string, { original: string; indices: number[]; bodyText: string } | undefined>()
    for (const [index, block] of projected.entries()) {
      const original = node.data.blocks[index]
      if (block.kind !== 'reasoning' || original?.kind !== 'reasoning') continue
      const bodyText = scope.playback.read(ids[index]!).text
      const previous = raw.get(block.text)
      if (!raw.has(block.text)) {
        raw.set(block.text, { original: original.text, indices: [index], bodyText })
      } else if (previous === undefined || previous.original !== original.text || previous.bodyText !== bodyText) {
        raw.set(block.text, undefined)
      } else {
        raw.set(block.text, { ...previous, indices: [...previous.indices, index] })
      }
    }
    return ((name: string, props: Record<string, unknown>, ...args: unknown[]) => {
      if (name === 'conversation.chat.reasoning.body' && typeof props.rawText === 'string') {
        const source = raw.get(props.rawText)
        if (source !== undefined) {
          const children = (render as Function)(name, { ...props, rawText: source.original, text: visibleReasoningText(source.bodyText) }, ...args)
          // Equal text cannot identify a row. Its own disclosure hook registers
          // expansion precisely; never let one body's token expand another row.
          return source.indices.length === 1 ? createElement(ReasoningBodyRegistration, {
            scope, keys: JSON.stringify([ids[source.indices[0]!]!]), children,
          }) : children
        }
      }
      return (render as Function)(name, props, ...args)
    }) as AssistantProps['renderSlot']
  }, [owner.renderSlot, node.data.blocks, projected, ownerKey, scope])
  if (!entered) return null
  return createElement(FollowHost, { active: pending, speedCpsRef: speed, revealedCharsRef: revealed,
    revealScaleRef: scope.revealScale,
    hostRef: root, controlScroll: scope.preferences.controlScroll, predictive: false,
    children: createElement(Inner, { ...owner, useDisclosure, ...(renderSlot === undefined ? {} : { renderSlot }), node: { ...node, data: { ...node.data, blocks: projected,
      status: pending ? 'running' : node.data.status } } }),
  })
}
