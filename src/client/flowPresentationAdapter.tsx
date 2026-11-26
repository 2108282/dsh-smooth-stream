import {
  createElement, Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ComponentType, type RefObject,
} from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantBlock, ChatFlowSlotProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationGroupData, GroupReference, GroupSnapshot, NodeReference } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { assistantProgress } from './presentationProgress.ts'
import { assistantTextSegments } from './NativeAssistantNodeView.tsx'
import { hasPresentedToolNode, isFollowableChatNode } from './TypewriterToolNodeView.tsx'
import {
  presentationOwnerAdmitted, presentationOwnerKey, readPresentationSource, reservePresentationSource,
  subscribePresentationOwner, subscribePresentationSource, usePresentationAdmission,
} from './usePresentationAdmission.ts'
import { isBackgroundRecoveryScope, useBackgroundRecovery } from './backgroundRecovery.ts'
import { relayScope, relayTurnKey, streamRelay, type RelayPart, type RelayScope } from './streamRelay.ts'
import type { BackgroundRecovery, StreamSettings } from '../settings.ts'

const CHAT_FLOW_SLOT = 'conversation.chat.flow'
const CHAT_NODE_SLOT = 'conversation.chat.node'
const PRESENTED_GROUP_LIMIT = 512

export type SettingsSource = {
  subscribe(listener: () => void): () => void
  getSnapshot(): StreamSettings
}

interface GroupSetState {
  revision: number
  listeners: Set<() => void>
}

const presentedGroups = new Set<string>()
const groupSetStates = new Map<string, GroupSetState>()

function groupIdentity(sessionId: string, key: string): string {
  return JSON.stringify([sessionId, key])
}

function groupSetState(sessionId: string): GroupSetState {
  const state = groupSetStates.get(sessionId) ?? { revision: 0, listeners: new Set<() => void>() }
  groupSetStates.set(sessionId, state)
  return state
}

function groupSetSnapshot(sessionId: string): number {
  return groupSetStates.get(sessionId)?.revision ?? 0
}

function subscribeGroupSet(sessionId: string, listener: () => void): () => void {
  const state = groupSetState(sessionId)
  state.listeners.add(listener)
  return () => { state.listeners.delete(listener) }
}

function publishGroupSet(sessionId: string): void {
  const state = groupSetState(sessionId)
  state.revision += 1
  for (const listener of [...state.listeners]) listener()
}

function rememberGroup(identity: string): boolean {
  if (presentedGroups.has(identity)) return false
  presentedGroups.add(identity)
  if (presentedGroups.size > PRESENTED_GROUP_LIMIT) {
    presentedGroups.delete(presentedGroups.values().next().value!)
  }
  return true
}

export function clearFlowPresentationState(): void {
  presentedGroups.clear()
  groupSetStates.clear()
}

interface OwnerDescriptor {
  scope: RelayScope
  part: RelayPart
  ownerKey: string
  queued: boolean
  previouslyPresented: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function ownerPart(node: unknown, reference: Pick<NodeReference, 'groupPart'>): RelayPart {
  const value = asRecord(node)
  const data = asRecord(value?.data)
  if (value?.kind === 'assistant-step') return reference.groupPart === 'reasoning' ? 'reasoning' : 'response'
  if (value?.kind === 'tool-call' || (data !== undefined && 'root' in data)) return 'tool'
  return 'output'
}

function ownerWasPresented(node: unknown, reference: Pick<NodeReference, 'groupPart'>, scope: RelayScope): boolean {
  const value = asRecord(node)
  if (value?.kind !== 'assistant-step') return hasPresentedToolNode(node, scope.session)
  const data = asRecord(value.data)
  const blocks = data?.blocks
  if (!Array.isArray(blocks)) return false
  const projection = assistantTextSegments(blocks as readonly AssistantBlock[], reference.groupPart)
  const part = ownerPart(node, reference)
  const key = JSON.stringify([scope.session, scope.turn, scope.step, scope.node, part])
  const prefix = assistantProgress.read(key, projection.segments.join(''))
  return prefix !== undefined && prefix !== ''
}

function describeOwner(node: unknown, reference: Pick<NodeReference, 'groupPart'>, sessionId: string): OwnerDescriptor {
  const scope = relayScope(node, sessionId)
  const part = ownerPart(node, reference)
  const position = Number.isFinite(scope.order)
    ? [scope.step, scope.order, part === 'reasoning' ? 0 : part === 'response' ? 1 : 2] as const
    : undefined
  const queued = isFollowableChatNode(node)
    || isBackgroundRecoveryScope(relayTurnKey(scope), position)
    || streamRelay.isBlocked(scope, part)
  return {
    scope,
    part,
    ownerKey: presentationOwnerKey(scope, part),
    queued,
    previouslyPresented: ownerWasPresented(node, reference, scope),
  }
}

function OwnerReservation({ nodeKey, groupPart, sessionId, enabled, recoveryMode, useChatNode, managedNodeKinds }: {
  nodeKey: string
  groupPart?: string | undefined
  sessionId: string
  enabled: boolean
  recoveryMode: BackgroundRecovery
  useChatNode: ChatFlowSlotProps['useChatNode']
  managedNodeKinds: ReadonlySet<string>
}) {
  const node = useChatNode(nodeKey, value => value)
  if (node === undefined || !managedNodeKinds.has(node.kind)) return null
  return createElement(OwnerReservationReady, { node, groupPart, sessionId, enabled, recoveryMode })
}

function OwnerReservationReady({ node, groupPart, sessionId, enabled, recoveryMode }: {
  node: unknown
  groupPart?: string | undefined
  sessionId: string
  enabled: boolean
  recoveryMode: BackgroundRecovery
}) {
  const reference = groupPart === undefined ? {} : { groupPart }
  const descriptor = describeOwner(node, reference, sessionId)
  const recoveryKey = relayTurnKey(descriptor.scope)
  const recoveryPosition = [descriptor.scope.step, descriptor.scope.order,
    descriptor.part === 'reasoning' ? 0 : descriptor.part === 'response' ? 1 : 2] as const
  const [recoveryEpoch, setRecoveryEpoch] = useState<number | undefined>(() =>
    recoveryMode !== 'latest' && isBackgroundRecoveryScope(recoveryKey, recoveryPosition)
      ? streamRelay.recoveryEpoch(recoveryKey) ?? 0 : undefined)
  const scope = { ...descriptor.scope, recoveryEpoch }
  const ownerState = useRef<{ ownerKey: string; required: boolean }>({ ownerKey: descriptor.ownerKey, required: false })
  if (ownerState.current.ownerKey !== descriptor.ownerKey) {
    ownerState.current = { ownerKey: descriptor.ownerKey, required: false }
  }
  if (descriptor.queued && !descriptor.previouslyPresented) ownerState.current.required = true
  const shouldQueue = ownerState.current.required && !descriptor.previouslyPresented
  const root = useRef<HTMLElement>(null)
  const admitted = usePresentationAdmission(
    scope,
    descriptor.part,
    enabled && shouldQueue,
    true,
    root as RefObject<HTMLElement | null>,
    !enabled || !shouldQueue || descriptor.previouslyPresented,
    descriptor.ownerKey,
    true,
  )
  const reserving = enabled && shouldQueue && !admitted
  const sourceReservation = useRef<(() => void) | undefined>(undefined)
  const releaseSource = () => { sourceReservation.current?.(); sourceReservation.current = undefined }
  const freezeSource = (epoch: number) => {
    if (reserving && recoveryMode !== 'latest' && sourceReservation.current === undefined) {
      sourceReservation.current = reservePresentationSource(descriptor.ownerKey, scope, epoch, node)
    }
  }
  const joinRecovery = () => {
    const epoch = recoveryMode === 'latest' ? undefined : streamRelay.recoveryEpoch(recoveryKey) ?? 0
    setRecoveryEpoch(epoch)
    return epoch
  }
  const playback = useBackgroundRecovery(recoveryMode,
    () => { releaseSource(); joinRecovery() },
    () => { const epoch = joinRecovery(); if (epoch !== undefined) freezeSource(epoch) },
    recoveryKey, recoveryPosition, false, reserving)
  useLayoutEffect(() => {
    if (!enabled || recoveryMode === 'latest') releaseSource()
    else if (recoveryEpoch !== undefined && !playback.hidden()) freezeSource(recoveryEpoch)
  }, [enabled, recoveryMode, recoveryEpoch, reserving, node])
  useLayoutEffect(() => () => { releaseSource() }, [descriptor.ownerKey])
  useLayoutEffect(() => {
    if (!reserving || recoveryMode === 'latest' || recoveryEpoch === undefined) return
    // A group without its renderer still belongs to the frozen snapshot. Keep
    // that batch alive until its real member takes over the same epoch's lease.
    const lease = streamRelay.acquire(scope, descriptor.part)
    return () => { streamRelay.release(lease) }
  }, [reserving, recoveryMode, recoveryEpoch, recoveryKey, scope.step, scope.node, scope.order, descriptor.part])
  return null
}

function GroupOwnerReservations({ groupKey, sessionId, enabled, recoveryMode, useChatGroup, useChatNode, managedNodeKinds }: {
  groupKey: GroupReference['key']
  sessionId: string
  enabled: boolean
  recoveryMode: BackgroundRecovery
  useChatGroup: ChatFlowSlotProps['useChatGroup']
  useChatNode: ChatFlowSlotProps['useChatNode']
  managedNodeKinds: ReadonlySet<string>
}) {
  const group = useChatGroup(groupKey, value => value)
  if (group === undefined) return null
  return createElement(Fragment, null, ...group.members.map((member, index) => createElement(OwnerReservation, {
    key: `${member.key}:${member.groupPart ?? ''}:${index}`,
    nodeKey: member.key,
    groupPart: member.groupPart,
    sessionId,
    enabled,
    recoveryMode,
    useChatNode,
    managedNodeKinds,
  })))
}

export function FlowPresentationAdapter({ Inner, props, settings, managedNodeKinds }: {
  Inner: ComponentType<ChatFlowSlotProps>
  props: ChatFlowSlotProps
  settings: SettingsSource
  managedNodeKinds: ReadonlySet<string>
}) {
  const preferences = useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot)
  const sessionId = String(props.sessionId)
  const versionSubscribe = useCallback((listener: () => void) => subscribeGroupSet(sessionId, listener), [sessionId])
  const versionSnapshot = useCallback(() => groupSetSnapshot(sessionId), [sessionId])
  const groupSetVersion = useSyncExternalStore(versionSubscribe, versionSnapshot, versionSnapshot)
  const gatedUseChatNode = useCallback((key: string, selector?: (value: unknown) => unknown) => {
    const node = props.useChatNode(key, value => value)
    const subscribe = useCallback((listener: () => void) => subscribePresentationSource(sessionId, key, listener), [key, sessionId])
    const read = useCallback(() => readPresentationSource(sessionId, key), [key, sessionId])
    const frozen = useSyncExternalStore(subscribe, read, read)
    const projected = useMemo(() => {
      const data = asRecord(node?.data)
      const frozenData = asRecord(asRecord(frozen)?.data)
      if (node === undefined || data === undefined || frozenData === undefined || data.status === 'interrupted') return node
      // Keep current ownership/location/status, but do not fold a later source
      // suffix into a waiting member's original foreground snapshot.
      return { ...node, data: { ...frozenData, ...('status' in data ? { status: data.status } : {}) } }
    }, [node, frozen])
    return selector === undefined ? projected : selector(projected)
  }, [props.useChatNode, sessionId])
  const gatedUseChatGroup = useCallback((key: string,
    selector?: (value: GroupSnapshot<ConversationGroupData<'chat'>> | undefined) => unknown) => {
    const group = props.useChatGroup(key, value => value)
    const firstMember = group?.members[0]
    const firstNode = props.useChatNode(firstMember?.key ?? '', value => value)
    const descriptor = firstMember !== undefined && firstNode !== undefined && managedNodeKinds.has(firstNode.kind)
      ? describeOwner(firstNode, firstMember, sessionId)
      : undefined
    const identity = groupIdentity(sessionId, key)
    const ownerKey = descriptor?.ownerKey
    const subscribeOwner = useCallback((listener: () => void) => ownerKey === undefined
      ? () => {}
      : subscribePresentationOwner(ownerKey, listener), [ownerKey])
    const readOwner = useCallback(() => ownerKey !== undefined && presentationOwnerAdmitted(ownerKey) === true,
      [ownerKey])
    const ownerAdmitted = useSyncExternalStore(subscribeOwner, readOwner, readOwner)
    const required = useRef<{ identity: string; ownerKey: string | undefined; queued: boolean; unresolved: boolean }>({
      identity, ownerKey, queued: false, unresolved: false,
    })
    if (required.current.identity !== identity) {
      required.current = { identity, ownerKey, queued: false, unresolved: false }
    } else if (required.current.ownerKey !== undefined && required.current.ownerKey !== ownerKey) {
      required.current = { identity, ownerKey, queued: false, unresolved: false }
    } else {
      required.current.ownerKey = ownerKey
    }
    const hasMembers = (group?.members.length ?? 0) > 0
    if (preferences.enabled && hasMembers && firstNode === undefined) {
      required.current.unresolved = true
    } else if (firstNode !== undefined && descriptor === undefined) {
      required.current.queued = false
      required.current.unresolved = false
    } else if (descriptor !== undefined) {
      if (descriptor.queued && !descriptor.previouslyPresented) {
        required.current.queued = true
        required.current.unresolved = false
      } else if (required.current.unresolved && !descriptor.queued) {
        required.current.queued = false
        required.current.unresolved = false
      }
    }
    const wasPresented = presentedGroups.has(identity)
    const needsGate = preferences.enabled && (required.current.queued || required.current.unresolved) && !wasPresented
    const ready = !preferences.enabled || wasPresented || descriptor?.previouslyPresented === true
      || (!needsGate && (!hasMembers || firstNode !== undefined)) || ownerAdmitted
    useLayoutEffect(() => {
      if (group === undefined || !ready || !rememberGroup(identity)) return
      if (needsGate) publishGroupSet(sessionId)
    }, [group, identity, needsGate, ready, sessionId])
    return ready ? (selector === undefined ? group : selector(group)) : undefined
  }, [managedNodeKinds, preferences.enabled, props.useChatGroup, props.useChatNode, sessionId])

  const useGroupAction = useCallback((hidden: boolean, reveal: () => void) => {
    const versionedReveal = useCallback(() => reveal(), [reveal, groupSetVersion])
    return props.useGroupAction(hidden, versionedReveal)
  }, [groupSetVersion, props.useGroupAction])
  const useGroupHeaderAction = useCallback((ref: RefObject<HTMLElement | null>, hidden: boolean) => {
    const versionedRef = useMemo<RefObject<HTMLElement | null>>(() => ({
      get current() { return ref.current },
    }), [ref, groupSetVersion])
    return props.useGroupHeaderAction(versionedRef, hidden)
  }, [groupSetVersion, props.useGroupHeaderAction])

  const reservations = preferences.enabled ? props.entries.map((entry, index) => entry.kind === 'node'
    ? createElement(OwnerReservation, {
      key: `node:${entry.key}:${entry.groupPart ?? ''}:${index}`,
      nodeKey: entry.key,
      groupPart: entry.groupPart,
      sessionId,
      enabled: true,
      recoveryMode: preferences.backgroundRecovery,
      managedNodeKinds,
      useChatNode: props.useChatNode,
    })
    : createElement(GroupOwnerReservations, {
      key: `group:${entry.key}:${index}`,
      groupKey: entry.key,
      sessionId,
      enabled: true,
      recoveryMode: preferences.backgroundRecovery,
      managedNodeKinds,
      useChatGroup: props.useChatGroup,
      useChatNode: props.useChatNode,
    })) : []

  return createElement(Fragment, null, ...reservations, createElement(Inner, {
    ...props,
    useChatNode: gatedUseChatNode as ChatFlowSlotProps['useChatNode'],
    useChatGroup: gatedUseChatGroup as ChatFlowSlotProps['useChatGroup'],
    useGroupAction,
    useGroupHeaderAction,
  }))
}

/** Decorate the installed Chat Flow component without changing its official entries or child slots. */
export function installFlowPresentationAdapter(ctx: Context, settings: SettingsSource,
  canManageRenderer: (key: string, component: unknown) => boolean): () => void {
  const originals = new Map<StoredEntry, { original: unknown; wrapped: unknown }>()
  const listeners = new Set<() => void>()
  let revision = 0
  let disposed = false
  let lastSlotVersion = ctx.slots.getVersion(CHAT_FLOW_SLOT)
  let lastNodeVersion = ctx.slots.getVersion(CHAT_NODE_SLOT)
  const subscribe = (listener: () => void): (() => void) => {
    if (disposed) return () => {}
    listeners.add(listener)
    const offFlow = ctx.slots.subscribe(CHAT_FLOW_SLOT, listener)
    const offNodes = ctx.slots.subscribe(CHAT_NODE_SLOT, listener)
    return () => { offFlow(); offNodes(); listeners.delete(listener) }
  }
  const getSnapshot = (): string => {
    if (!disposed) {
      lastSlotVersion = ctx.slots.getVersion(CHAT_FLOW_SLOT)
      lastNodeVersion = ctx.slots.getVersion(CHAT_NODE_SLOT)
    }
    return `${lastSlotVersion}:${lastNodeVersion}:${revision}:${disposed}`
  }
  const apply = (): void => {
    if (disposed) return
    for (const entry of ctx.slots.entries(CHAT_FLOW_SLOT)) {
      if (originals.get(entry)?.wrapped === entry.component) continue
      const original = entry.component
      if (typeof original !== 'function' && (original === null || typeof original !== 'object' || !('$$typeof' in original))) continue
      const Inner = original as ComponentType<ChatFlowSlotProps>
      const wrapped = function SmoothStreamFlowEntry(props: ChatFlowSlotProps) {
        const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
        // Only decorated keyed renderers can consume a reservation. Native
        // chrome and JsonBlock fallbacks never enter the admission hook.
        const managedNodeKinds = useMemo(() => new Set(disposed ? [] : ctx.slots.entries(CHAT_NODE_SLOT)
          .filter(nodeEntry => canManageRenderer(String(nodeEntry.options.key), nodeEntry.component))
          .map(nodeEntry => String(nodeEntry.options.key))), [version])
        return disposed ? createElement(Inner, props)
          : createElement(FlowPresentationAdapter, { Inner, props, settings, managedNodeKinds })
      }
      originals.set(entry, { original, wrapped })
      entry.component = wrapped
    }
  }
  const off = ctx.slots.subscribe(CHAT_FLOW_SLOT, apply)
  apply()
  return () => {
    if (disposed) return
    disposed = true
    revision += 1
    for (const listener of [...listeners]) listener()
    off()
    for (const [entry, record] of originals) {
      if (entry.component === record.wrapped) entry.component = record.original
    }
    originals.clear()
  }
}
