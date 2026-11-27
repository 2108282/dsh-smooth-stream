import {
  createContext, createElement, Fragment, useCallback, useContext, useEffect, useId, useLayoutEffect,
  useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode,
} from 'react'
import type { AssistantBlock, ChatFlowSlotProps, ChatNode, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { flushSync } from 'react-dom'
import { PRESET_CONFIG, type StreamSmoothingPreset } from './useSmoothStreamContent.ts'
import { flushConversationPublications } from './conversationPipeline.ts'
import type { SettingsSource } from './flowPresentationAdapter.tsx'
import { SessionPlayback, type PlaybackDisplay, type PlaybackSegment } from './sessionPlayback.ts'
import { FollowHost } from './FollowHost.tsx'
import { FADE_DURATION_MS, useLogarithmicFade } from './useLogarithmicFade.ts'
import { useBackgroundRecovery } from './backgroundRecovery.ts'
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
interface PlaybackBlockIdentity {
  key: string
  seq: number
  generation: string
}
function blockIds(scope: PlaybackScope, node: SourceNode): string[] {
  // Playback progress belongs to the source block, not to the renderer's
  // current visual partition (reasoning/response/grouped/ungrouped).
  return scope.blocks(node).map(block => segmentId(node.key, block.key))
}

/** One playback clock belongs to the injected Flow, never to a node renderer. */
export class PlaybackScope {
  readonly playback = new SessionPlayback()
  preferences: StreamSettings = DEFAULT_STREAM_SETTINGS
  active = true
  suspended = false
  speedCps = 110
  initial = true
  initialMaxSeq = Number.NEGATIVE_INFINITY
  readonly initialOwners = new Set<string>()
  readonly animatedOwners = new Set<string>()
  readonly recoveredOwners = new Set<string>()
  private readonly sources = new Map<string, { sourceKey: string; segments: readonly PlaybackSegment[] }>()
  private readonly tools = new Map<string, SourceNode>()
  private revision = 0
  private readonly listeners = new Set<() => void>()
  private readonly flags = new Map<string, Map<string, boolean>>()
  private readonly registrations = new Map<string, symbol>()
  private readonly initialSources = new Map<string, { segments: readonly PlaybackSegment[]; node: SourceNode | undefined }>()
  private readonly blockIdentities = new Map<string, { node: SourceNode; blocks: readonly PlaybackBlockIdentity[] }>()
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
  register(owner: string, segments: readonly PlaybackSegment[], node: SourceNode | undefined): void {
    const sourceKey = sourceIdentity(owner, node)
    const previousTool = this.tools.get(owner)
    if (node?.kind === 'tool-call') this.tools.set(owner, node)
    else this.tools.delete(owner)
    if ((previousTool?.anchorSeq ?? Infinity) !== (this.tools.get(owner)?.anchorSeq ?? Infinity)) this.publish()
    if (this.initial) {
      this.initialOwners.add(sourceKey)
      this.initialMaxSeq = Math.max(this.initialMaxSeq, node?.anchorSeq ?? Number.NEGATIVE_INFINITY)
      this.initialSources.set(owner, { segments, node })
      return
    }
    if ((node?.kind === 'assistant-step' && node.data.status === 'running')
      || (!this.initialOwners.has(sourceKey) && (node?.anchorSeq ?? 0) > this.initialMaxSeq)) this.animatedOwners.add(sourceKey)
    this.sources.set(owner, { sourceKey, segments })
    if (this.suspended) this.rememberRecovery(sourceKey, segments)
    const location = node?.location
    const reason = location?.kind === 'turn' || location?.kind === 'step' ? location.turn.end?.data.reason.kind : undefined
    const interrupted = (node?.kind === 'assistant-step' && node.data.status === 'interrupted')
      || reason === 'error' || reason === 'aborted' || reason === 'interrupted'
    // A cancelled historical turn must never advance another turn's cursor.
    this.playback.upsert(owner, segments, this.animatedOwners.has(sourceKey) && !interrupted)
  }
  sealInitial(): void {
    if (!this.initial) return
    let liveSeq = Number.POSITIVE_INFINITY
    for (const { node, segments } of this.initialSources.values()) {
      if (node?.kind !== 'assistant-step' || node.data.status !== 'running') continue
      for (const segment of segments) liveSeq = Math.min(liveSeq, segment.order[0]!)
    }
    this.initial = false
    for (const [owner, { segments, node }] of this.initialSources) {
      if (segments.some(segment => segment.order[0]! >= liveSeq)) {
        this.animatedOwners.add(sourceIdentity(owner, node))
      }
      this.register(owner, segments, node)
    }
    this.initialSources.clear()
    this.playback.sealInitial()
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
  private rememberRecovery(owner: string, segments: readonly PlaybackSegment[]): void {
    if (this.animatedOwners.has(owner) && segments.some(segment => {
      const display = this.playback.read(segment.id)
      return display.pending || !display.entered || display.text !== segment.text
    })) this.recoveredOwners.add(owner)
  }
  suspend(value: boolean): void {
    if (value) {
      for (const { sourceKey, segments } of this.sources.values()) this.rememberRecovery(sourceKey, segments)
    }
    if (this.suspended !== value) { this.suspended = value; this.publish() }
    if (value) this.playback.pause()
    else this.playback.resume()
  }
  retain(owner: string): () => void {
    const token = Symbol(owner)
    this.registrations.set(owner, token)
    return () => {
      // StrictMode reattaches synchronously. Remove only truly departed sources.
      queueMicrotask(() => {
        if (this.registrations.get(owner) !== token) return
        this.registrations.delete(owner)
        this.sources.delete(owner)
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
  const segments = useMemo<readonly PlaybackSegment[]>(() => {
    if (node === undefined || !managedKinds.has(node.kind)) return []
    if (node.kind !== 'assistant-step') return [{ id: segmentId(nodeKey, -1), order: [node.anchorSeq, ...order, 0],
      text: '', sealed: true, hidden, awaitPresentation: scope.preferences.controlScroll }]
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
      return [{ id: ids[index]!, order: [blockIdentity.seq, ...order, index],
        generation: blockIdentity.generation,
        text: block.kind === 'text' || block.kind === 'reasoning' ? block.text : '',
        sealed: sealed[index] === true,
        hidden: hidden || (!scope.preferences.keepStreamOnToolCall && blockIdentity.seq <= toolBoundary && toolBoundary !== Infinity)
          || (block.kind === 'reasoning' && ((scope.flag(`disclosure-known:${ids[index]}`)
          && !scope.flag(`expanded:${ids[index]}`)) || scope.flag(`reasoning-hidden:${owner}`))) }]
    })
  }, [node, owner, shape, controlRevision, hidden, groupPart, managedKinds, scope,
    scope.preferences.controlScroll, scope.preferences.keepStreamOnToolCall])
  useLayoutEffect(() => scope.retain(owner), [scope, owner])
  useLayoutEffect(() => groupKey === undefined ? undefined
    : scope.setFlag(`unmanaged:${groupKey}`, owner, node !== undefined && !managedKinds.has(node.kind)),
  [scope, groupKey, owner, node?.kind, managedKinds])
  useLayoutEffect(() => { scope.register(owner, segments, node) }, [scope, owner, segments, node])
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
  const scope = useMemo(() => new PlaybackScope(), [])
  scope.preferences = preferences
  const resumption = useRef(0)
  const lifetime = useRef(0)
  const recoveryRef = useRef<ReturnType<typeof useBackgroundRecovery> | null>(null)
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
  const settleDelayMs = preferences.logarithmicFade && typeof Highlight === 'function'
    && typeof CSS !== 'undefined' && CSS.highlights !== undefined
    && CSS.supports('color', 'color-mix(in srgb, currentColor 15%, transparent)') ? FADE_DURATION_MS : 0
  useLayoutEffect(() => {
    scope.speedCps = PRESET_CONFIG[preset].defaultCps * tuning.revealScale
    scope.playback.configure({ charsPerSecond: PRESET_CONFIG[preset].defaultCps, tuning, settleDelayMs })
    scope.playback.setEnabled(active)
    if (!active) scope.suspend(false)
  }, [scope, active, preset, tuning, settleDelayMs])
  const recovery = useBackgroundRecovery(preferences.backgroundRecovery,
    () => { resumption.current++; scope.suspend(true) },
    () => {
      const recovery = recoveryRef.current
      recovery?.finish()
      if (recovery?.recovering()) return
      // Publish accepted background chunks before freezing the recovery frontier.
      // This is the borrowed Conversation binding, never another network stream.
      flushSync(() => { flushConversationPublications() })
      const version = ++resumption.current
      queueMicrotask(() => {
        if (version !== resumption.current || recoveryRef.current?.hidden() || !scope.active) return
        scope.playback.beginRecovery(scope.preferences.backgroundRecovery)
        scope.suspend(false)
      })
    }, JSON.stringify([props.sessionId]), undefined, false, active)
  recoveryRef.current = recovery
  useLayoutEffect(() => { scope.sealInitial() }, [scope, props.entries.length])
  useLayoutEffect(() => {
    if (active && (recoveryRef.current?.hidden() || recoveryRef.current?.recovering())) scope.suspend(true)
    return () => { resumption.current++ }
  }, [scope])
  // Suspense hiding cleans up layout effects but retains this scope. Only a
  // passive lifetime cleanup may dispose it; the generation guards StrictMode.
  useEffect(() => {
    const generation = ++lifetime.current
    return () => {
      queueMicrotask(() => {
        if (lifetime.current === generation) scope.playback.dispose()
      })
    }
  }, [scope])
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
          && scope.playback.read(ids[index]!).entered)
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
      return block.kind === 'tool-call' ? [] : [all[index]!]
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

/** Cards enter whole; this host only follows their committed height. */
function SessionPlaybackAtomic({ Inner, owner, scope, sourceKey }: {
  Inner: ComponentType<any>; owner: NodeProps; scope: PlaybackScope; sourceKey: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const speed = useRef(scope.speedCps)
  speed.current = scope.speedCps
  const extent = useRef<number | null>(null)
  const id = segmentId(sourceKey, -1)
  const [entering, setEntering] = useState(() => scope.animatedOwners.has(sourceKey) && scope.playback.read(id).pending)
  const finish = useCallback(() => {
    extent.current = null
    setEntering(false)
    scope.playback.acknowledgePresentation(id)
  }, [scope, id])
  const awaiting = scope.playback.read(id).pending
  useLayoutEffect(() => {
    if (!awaiting) { extent.current = null; setEntering(false); return }
    if (!entering || scope.suspended) return
    const element = root.current
    const port = element?.closest<HTMLElement>('[data-conversation-scroll]')
    // No controlled scroll entrance exists without a measurable native port.
    // Release immediately instead of waiting for a callback that cannot arrive.
    if (!scope.preferences.controlScroll || !port?.isConnected || port.clientHeight <= 0
      || !element || element.getBoundingClientRect().height <= 0) finish()
  }, [scope, entering, awaiting, scope.suspended, scope.preferences.controlScroll, finish])
  const growth = useCallback((delta: number) => {
    if (scope.suspended || !scope.preferences.controlScroll || !scope.playback.read(id).pending) return
    extent.current = (extent.current ?? 0) + delta
    setEntering(true)
    notifyFollowCommit(root.current)
  }, [scope, id])
  return createElement(FollowHost, {
    active: false, entrance: entering && !scope.suspended && scope.playback.read(id).pending,
    onEntranceSettled: finish, onGrowth: scope.preferences.controlScroll ? growth : undefined,
    entranceExtentRef: extent, speedCpsRef: speed, hostRef: root,
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
    && scope.playback.read(ids[index]!).pending)
  const recovered = scope.recoveredOwners.has(sourceIdentity(ownerKey, node))
  const useDisclosure = useMemo(() => function usePlaybackDisclosure() {
    const disclosure = officialDisclosure()
    const token = useId()
    const manual = useRef(false)
    const autoOpened = useRef(false)
    const autoExpand = !manual.current && scope.preferences.thinkAutoExpand && reasoningPending && !recovered
    useLayoutEffect(() => {
      if (manual.current) return
      if (recovered && disclosure.expanded) {
        autoOpened.current = false
        disclosure.setExpanded(false)
      } else if (autoExpand && !disclosure.expanded) {
        autoOpened.current = true
        disclosure.setExpanded(true)
      } else if (!autoExpand && autoOpened.current) {
        autoOpened.current = false
        disclosure.setExpanded(false)
      }
    }, [disclosure.setExpanded, disclosure.expanded, autoExpand, recovered])
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
  }, [officialDisclosure, ownerKey, scope, reasoningPending, recovered])
  const projected: AssistantBlock[] = []
  let pending = false
  let entered = false
  for (const [index, block] of node.data.blocks.entries()) {
    const relevant = owner.groupPart === 'reasoning' ? block.kind === 'reasoning'
      : owner.groupPart === 'response' ? block.kind !== 'reasoning' : true
    if (!relevant || block.kind === 'tool-call') { projected.push(block); continue }
    const display = scope.playback.read(ids[index]!)
    pending ||= display.pending
    entered ||= display.entered
    // Keep native block indices (and disclosure keys) even when protocol order
    // interleaves a later dense block or a Tool card ahead of this one.
    projected.push(!display.entered ? { kind: 'text', text: '' }
      : block.kind === 'text' || block.kind === 'reasoning' ? { ...block, text: display.text } : block)
  }
  mountedReasoning.current = projected.flatMap((block, index) => block.kind === 'reasoning' && block.text.trim() !== ''
    && (owner.groupPart === undefined || owner.groupPart === 'reasoning') ? [ids[index]!] : [])
  const displayedLength = projected.reduce((sum, block) => sum + (block.kind === 'text' || block.kind === 'reasoning' ? block.text.length : 0), 0)
  useLayoutEffect(() => {
    revealed.current = displayedLength
    notifyFollowCommit(root.current)
  }, [displayedLength])
  const renderSlot = useMemo(() => {
    if (owner.renderSlot === undefined) return undefined
    const render = owner.renderSlot
    const raw = new Map<string, { original: string; indices: number[] } | undefined>()
    for (const [index, block] of projected.entries()) {
      const original = node.data.blocks[index]
      if (block.kind !== 'reasoning' || original?.kind !== 'reasoning') continue
      const previous = raw.get(block.text)
      raw.set(block.text, !raw.has(block.text) ? { original: original.text, indices: [index] }
        : previous?.original === original.text ? { ...previous, indices: [...previous.indices, index] } : undefined)
    }
    return ((name: string, props: Record<string, unknown>, ...args: unknown[]) => {
      if (name === 'conversation.chat.reasoning.body' && typeof props.rawText === 'string') {
        const source = raw.get(props.rawText)
        if (source !== undefined) {
          const children = (render as Function)(name, { ...props, rawText: source.original }, ...args)
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
  // The session cursor already owns this prefix. A fresh DOM host adopts it;
  // only characters appended after attachment may start a new fade.
  useLogarithmicFade(root, scope.preferences.logarithmicFade, pending, speed, scope.suspended, true)
  if (!entered) return null
  return createElement(FollowHost, { active: pending && !scope.suspended, speedCpsRef: speed, revealedCharsRef: revealed,
    hostRef: root, controlScroll: scope.preferences.controlScroll, predictive: false,
    children: createElement(Inner, { ...owner, useDisclosure, ...(renderSlot === undefined ? {} : { renderSlot }), node: { ...node, data: { ...node.data, blocks: projected,
      status: pending ? 'running' : node.data.status } } }),
  })
}
