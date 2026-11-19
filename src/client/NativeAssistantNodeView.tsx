import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { AssistantBlock, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { FollowHost } from './FollowHost.tsx'
import { notifyFollowCommit } from './teleprompterGlide.ts'
import { LARGE_RECOVERY_BACKLOG_CHARS, countChars, useSmoothStreamContent, type StreamSmoothingPreset } from './useSmoothStreamContent.ts'
import { useLogarithmicFade } from './useLogarithmicFade.ts'
import type { StreamSettings } from '../settings.ts'
import { relayScope, relayTurnKey, streamRelay } from './streamRelay.ts'
import { isBackgroundRecoveryScope } from './backgroundRecovery.ts'

export interface NativeAssistantPreferences extends Pick<StreamSettings,
  'controlScroll' | 'motionPreference' | 'logarithmicFade' | 'thinkAutoExpand' | 'keepStreamOnToolCall'> {
  preset: StreamSmoothingPreset
  backgroundRecovery?: StreamSettings['backgroundRecovery']
}

type AssistantProps = ChatNodeViewProps<'assistant-step'>
interface NativeProps {
  /** Keep the shipped renderer and all of its injected capabilities intact. */
  Inner: ComponentType<AssistantProps>
  owner: AssistantProps
  preferences: NativeAssistantPreferences
}

function useReducedMotion(preference: StreamSettings['motionPreference']): boolean {
  const [system, setSystem] = useState(() => typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const change = (): void => { setSystem(query.matches) }
    change()
    query.addEventListener('change', change)
    return () => { query.removeEventListener('change', change) }
  }, [])
  return preference === 'force-reduced' || (preference === 'auto' && system)
}

/** Compact text projection plus source indices for a grouped renderer row. */
export interface AssistantTextProjection {
  segments: readonly string[]
  blockIndices: readonly number[]
}

interface ProjectedBlock {
  readonly source: AssistantBlock
  readonly end: number
  readonly block: AssistantBlock
}

interface ProjectionCache {
  readonly source: string
  readonly offsets: readonly number[]
  readonly partials: Map<number, ProjectedBlock>
}

// Keep the public projection shape compatible with callers constructing it by
// hand. The cache lives only as long as that immutable source projection does.
const projectionCaches = new WeakMap<AssistantTextProjection, ProjectionCache>()

function projectionCache(projection: AssistantTextProjection): ProjectionCache {
  const cached = projectionCaches.get(projection)
  if (cached !== undefined) return cached
  let offset = 0
  const offsets = projection.segments.map(segment => {
    const start = offset
    offset += segment.length
    return start
  })
  const cache = { source: projection.segments.join(''), offsets, partials: new Map<number, ProjectedBlock>() }
  projectionCaches.set(projection, cache)
  return cache
}

/** Only smooth text this grouped row actually owns; its other blocks retain their source data. */
export function assistantTextSegments(blocks: readonly AssistantBlock[], groupPart?: string): AssistantTextProjection {
  const segments: string[] = []
  const blockIndices: number[] = []
  blocks.forEach((block, index) => {
    if (block.kind === 'reasoning' && groupPart !== 'response') {
      segments.push(block.text)
      blockIndices.push(index)
    } else if (block.kind === 'text' && groupPart !== 'reasoning') {
      segments.push(block.text)
      blockIndices.push(index)
    }
  })
  return { segments, blockIndices }
}

/** Avoid splitting a code point even if an external caller supplies a partial surrogate prefix. */
function codePointEnd(source: string, end: number): number {
  if (end <= 0 || end >= source.length) return end
  const previous = source.charCodeAt(end - 1)
  const next = source.charCodeAt(end)
  return previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF ? end - 1 : end
}

/** Distribute a committed prefix without changing block count, order, identity or opaque metadata. */
export function revealAssistantBlocks(blocks: readonly AssistantBlock[], projection: AssistantTextProjection, shown: string): readonly AssistantBlock[] {
  const cache = projectionCache(projection)
  // The smoother returns a source prefix at code-point boundaries. Its UTF-16
  // length is already the slicing budget; recounting every displayed/source
  // character here made each reveal frame proportional to the full reply.
  const end = codePointEnd(cache.source, Math.min(shown.length, cache.source.length))
  if (end === cache.source.length) return blocks
  let next: AssistantBlock[] | undefined
  projection.blockIndices.forEach((blockIndex, segmentIndex) => {
    const source = projection.segments[segmentIndex]
    const start = cache.offsets[segmentIndex]
    const block = blocks[blockIndex]
    if (source === undefined || start === undefined || block === undefined
      || (block.kind !== 'text' && block.kind !== 'reasoning')) return
    const count = codePointEnd(source, Math.max(0, Math.min(end - start, source.length)))
    if (count === source.length) return
    const previous = cache.partials.get(blockIndex)
    const partial = previous?.source === block && previous.end === count
      ? previous.block
      : { ...block, text: source.slice(0, count) }
    if (partial !== previous?.block) cache.partials.set(blockIndex, { source: block, end: count, block: partial })
    next ??= blocks.slice()
    next[blockIndex] = partial
  })
  return next ?? blocks
}

type DisclosureHook = AssistantProps['useDisclosure']

/** Call the official Hook in every ReasoningRow, retaining its reset subscription. */
function useAutomaticDisclosure(official: DisclosureHook, enabled: boolean, active: boolean): DisclosureHook {
  return useMemo(() => function useStreamDisclosure() {
    const disclosure = official()
    const state = useRef({ manual: false, autoOpened: false, setter: disclosure.setExpanded, expanded: disclosure.expanded })
    // The bound official Hook changes its setter on a reset generation. Also
    // honour an external collapse (including a reset while auto-opened).
    if (state.current.setter !== disclosure.setExpanded
      || (state.current.expanded && !disclosure.expanded && state.current.autoOpened)) {
      state.current.manual = true
      state.current.autoOpened = false
    }
    state.current.setter = disclosure.setExpanded
    state.current.expanded = disclosure.expanded
    const auto = enabled
    const streaming = active
    useEffect(() => {
      if (state.current.manual) return
      if (auto && streaming && !disclosure.expanded) {
        state.current.autoOpened = true
        disclosure.setExpanded(true)
      } else if ((!auto || !streaming) && state.current.autoOpened) {
        state.current.autoOpened = false
        disclosure.setExpanded(false)
      }
    }, [auto, streaming, disclosure.expanded, disclosure.setExpanded])
    const setExpanded = useCallback((open: boolean) => {
      state.current.manual = true
      state.current.autoOpened = false
      disclosure.setExpanded(open)
    }, [disclosure.setExpanded])
    const toggle = useCallback(() => {
      state.current.manual = true
      state.current.autoOpened = false
      disclosure.toggle()
    }, [disclosure.toggle])
    return { ...disclosure, setExpanded, toggle }
  }, [official, enabled, active])
}

/**
 * Feed paced text to the shipped renderer instead of cloning Chat's UI.
 * Its registration still owns locale, children, disclosures, file gestures,
 * image loading, presentation policy and reasoning-translation extensions.
 */
export function NativeAssistantNodeView(props: NativeProps): ReactNode {
  const { owner } = props
  const key = JSON.stringify([owner.sessionId, owner.node.data.turn, owner.node.data.step, owner.node.key, owner.groupPart])
  // A new seat owns a fresh queue, even if its text extends the previous seat's
  // prefix. Within one seat the official Inner and disclosures stay mounted.
  return createElement(NativeAssistantSeat, { ...props, key })
}

function NativeAssistantSeat({ Inner, owner, preferences }: NativeProps): ReactNode {
  const { node, groupPart } = owner
  const { preset, controlScroll, logarithmicFade, motionPreference } = preferences
  const reduced = useReducedMotion(motionPreference)
  const live = node.data.status === 'running'
  const scope = useMemo(() => relayScope(node, owner.sessionId), [node.key, node.anchorSeq, node.data.turn, node.data.step, owner.sessionId])
  const recoveryKey = relayTurnKey(scope)
  const recoveryPosition = [scope.step, scope.order, groupPart === 'reasoning' ? 0 : 1] as const
  const recoveringScope = isBackgroundRecoveryScope(recoveryKey, recoveryPosition)
  const seenLive = useRef(live || recoveringScope)
  if (live || recoveringScope) seenLive.current = true
  const segments = useMemo(() => assistantTextSegments(node.data.blocks, groupPart), [node.data.blocks, groupPart])
  const source = projectionCache(segments).source
  const [recoveryBacklog, setRecoveryBacklog] = useState(() => !reduced && node.data.status !== 'interrupted'
    && recoveringScope && countChars(source) > LARGE_RECOVERY_BACKLOG_CHARS)
  const root = useRef<HTMLDivElement>(null)
  const speed = useRef(35)
  const revealed = useRef(0)
  const scale = useRef(1)
  // Playback policy never bypasses ordering. A first settled publication may
  // join a live queue even outside recovery; retain its own baton so several
  // late seats cannot all appear as soon as their common predecessor drains.
  const part = groupPart === 'reasoning' ? 'reasoning' : 'response'
  const blocked = useSyncExternalStore(streamRelay.subscribe,
    () => streamRelay.isBlocked(scope, part), () => false)
  if (blocked) seenLive.current = true
  const animate = seenLive.current && !reduced && node.data.status !== 'interrupted'
  const toolPresent = useSyncExternalStore(streamRelay.subscribe,
    () => streamRelay.hasTool(scope), () => false)
  const toolHandoff = !preferences.keepStreamOnToolCall
    && (toolPresent || node.data.blocks.some(block => block.kind === 'tool-call'))
  const hold = useRef(blocked)
  hold.current = blocked
  const smoothed = useSmoothStreamContent(source, {
    enabled: animate,
    backgroundRecovery: preferences.backgroundRecovery,
    recoveryKey: seenLive.current ? recoveryKey : undefined,
    recoveryPosition,
    replayOnEnable: true,
    onRecoveryBacklogChange: setRecoveryBacklog,
    inputComplete: !live || toolPresent || node.data.blocks.some(block => block.kind === 'tool-call')
      || (groupPart === 'reasoning' && node.data.blocks.at(-1)?.kind !== 'reasoning'),
    shouldHoldBack: () => hold.current,
    preset,
    speedCpsRef: speed,
    revealedCharsRef: revealed,
    revealScaleRef: scale,
    onRevealCommit: () => { notifyFollowCommit(root.current) },
  })
  const shown = animate && !toolHandoff ? smoothed : source
  const pending = animate && !toolHandoff && shown !== source
  const ownsLiveTail = live && !toolPresent && !node.data.blocks.some(block => block.kind === 'tool-call')
    && (groupPart !== 'reasoning' || node.data.blocks.at(-1)?.kind === 'reasoning')
  const typing = !toolHandoff && (ownsLiveTail || pending)
  const lease = useRef<symbol | null>(null)
  useLayoutEffect(() => {
    const token = streamRelay.acquire(scope, part, false)
    lease.current = token
    return () => {
      streamRelay.release(token)
      if (lease.current === token) lease.current = null
    }
  }, [scope, part])
  useLayoutEffect(() => {
    if (lease.current !== null) streamRelay.update(lease.current, animate && typing)
  }, [scope, part, animate, typing])
  const blocks = useMemo(() => animate && !toolHandoff
    ? revealAssistantBlocks(node.data.blocks, segments, shown)
    : node.data.blocks, [animate, toolHandoff, node.data.blocks, segments, shown])
  const reasoningPending = blocks.some((block, index) => block.kind === 'reasoning'
    && block.text !== (node.data.blocks[index] as { text?: string } | undefined)?.text)
  const reasoningTyping = !toolHandoff && (reasoningPending
    || (live && !toolPresent && node.data.blocks.at(-1)?.kind === 'reasoning'))
  // Recovery catches up silently; ordinary live reasoning keeps its usual
  // auto-expand policy, and the disclosure hook still honours manual choices.
  const useDisclosure = useAutomaticDisclosure(owner.useDisclosure, preferences.thinkAutoExpand && !recoveryBacklog, reasoningTyping && !blocked)
  // The Hook changes only with its policy/phase, so the official memo tree
  // observes completion even if the final text snapshot is unchanged. React
  // retains each ReasoningRow's Hook state and the official reset subscription.
  const adapted = useMemo(() => ({
    ...owner,
    useDisclosure,
    node: { ...node, data: { ...node.data, blocks,
      status: typing ? 'running' as const : live && !ownsLiveTail ? 'settled' as const : node.data.status } },
  }), [owner, node, blocks, useDisclosure, typing, live, ownsLiveTail])
  useLogarithmicFade(root, logarithmicFade && !reduced, typing, speed)
  useLayoutEffect(() => {
    const row = root.current?.closest('[data-chat-flow-key]')
    if (row === undefined || row === null) return
    if (typing) row.removeAttribute('data-smooth-stream-settled')
    else row.setAttribute('data-smooth-stream-settled', 'true')
    return () => { row.removeAttribute('data-smooth-stream-settled') }
  }, [typing])
  return (
    <div ref={root}
      style={blocked ? { opacity: 0, pointerEvents: 'none', height: 0, overflow: 'hidden' } : undefined}
      data-smooth-stream-phase={blocked ? 'waiting' : typing ? 'typing' : 'settled'}
      data-smooth-stream-typing={!blocked && typing ? 'true' : undefined}>
      <FollowHost active={!blocked && typing && !reduced} speedCpsRef={speed} revealedCharsRef={revealed}
        revealScaleRef={scale} controlScroll={controlScroll} predictive={ownsLiveTail}>
        {createElement(Inner, adapted)}
      </FollowHost>
    </div>
  )
}

