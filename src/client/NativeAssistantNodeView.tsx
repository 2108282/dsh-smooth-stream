import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { AssistantBlock, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { FollowHost } from './FollowHost.tsx'
import { notifyFollowCommit } from './teleprompterGlide.ts'
import { LARGE_RECOVERY_BACKLOG_CHARS, countChars, useSmoothStreamContent, type StreamSmoothingPreset } from './useSmoothStreamContent.ts'
import { useLogarithmicFade } from './useLogarithmicFade.ts'
import type { StreamSettings } from '../settings.ts'
import { relayScope, relayTurnKey, streamRelay } from './streamRelay.ts'
import { isBackgroundRecoveryScope } from './backgroundRecovery.ts'
import { assistantProgress } from './presentationProgress.ts'
import { STREAM_ORDER_DATA_KEY, type StreamOrderData } from './streamOrder.ts'
import { usePresentationAdmission, presentationOwnerKey } from './usePresentationAdmission.ts'

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

/** Keep future images/opaque blocks out of the renderer until their source position. */
export function projectAssistantPresentation(blocks: readonly AssistantBlock[], projection: AssistantTextProjection, shown: string): readonly AssistantBlock[] {
  const revealed = revealAssistantBlocks(blocks, projection, shown)
  if (revealed === blocks) return blocks
  const cache = projectionCache(projection)
  for (const [segmentIndex, blockIndex] of projection.blockIndices.entries()) {
    const source = projection.segments[segmentIndex]
    const start = cache.offsets[segmentIndex]
    if (source !== undefined && start !== undefined && shown.length < start + source.length) {
      // A prefix slice preserves every original index/key already rendered.
      // The current text block exists, but later structure has not been created.
      return revealed.slice(0, blockIndex + 1)
    }
  }
  return revealed
}

type DisclosureHook = AssistantProps['useDisclosure']

/** Match the official reasoning-text prefix filter without importing a Client plugin. */
function reasoningDisplayStart(text: string): number {
  if (text[0] !== '<') return 0
  const opening = '<signature>'
  if (opening.startsWith(text)) return text.length
  if (!text.startsWith(opening)) return 0
  const closing = '</signature>'
  const end = text.indexOf(closing, opening.length)
  if (end === -1) return text.length
  let start = end + closing.length
  while (start < text.length) {
    if (text[start] === '\n') start++
    else if (text[start] === '\r' && text[start + 1] === '\n') start += 2
    else break
  }
  return start
}
function blockSourceOrder(node: AssistantProps['node'], groupPart: string | undefined, shown: string): number | undefined {
  const location = node.location
  if (location.kind !== 'step') return undefined
  const data = location.step.data.get(STREAM_ORDER_DATA_KEY) as StreamOrderData | undefined
  if (data === undefined) return undefined
  let offset = 0
  for (const [index, block] of node.data.blocks.entries()) {
    if (block.kind !== 'reasoning' && block.kind !== 'text') continue
    if (groupPart === 'reasoning' && block.kind !== 'reasoning') continue
    if (groupPart === 'response' && block.kind !== 'text') continue
    const next = offset + countChars(block.text)
    if (shown.length < next) return data.blockSeqs.get(index)
    offset = next
  }
  return undefined
}
function hasVisibleReasoning(text: string): boolean {
  return text.slice(reasoningDisplayStart(text)).trim() !== ''
}

function hiddenAncestor(element: Element): boolean {
  let current: Element | null = element
  while (current !== null) {
    if (current.hasAttribute('hidden') || current.hasAttribute('data-turn-process-inline')) return true
    if (current instanceof HTMLElement && (current.style.display === 'none' || current.style.contentVisibility === 'hidden')) return true
    const style = getComputedStyle(current)
    if (style.display === 'none' || style.contentVisibility === 'hidden') return true
    current = current.parentElement
  }
  return false
}

/** Observe the official disclosures, not a second invocation of their independent Hook. */
function useCollapsedReasoning(root: { current: HTMLDivElement | null }, blocks: readonly AssistantBlock[], active: boolean,
  disclosureRows: { current: Map<number, HTMLElement> },
  setCollapsed: (update: (previous: readonly number[]) => readonly number[]) => void,
  setHidden: (update: (previous: boolean) => boolean) => void) {
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  // Header identities change only when a nonblank reasoning block enters/leaves;
  // character commits do not rescan the expanded Markdown tree.
  const shape = blocks.flatMap((block, index) => block.kind === 'reasoning' && hasVisibleReasoning(block.text) ? [index] : []).join(',')
  useLayoutEffect(() => {
    const element = root.current
    if (!active || element === null) return
    const indices = shape === '' ? [] : shape.split(',').map(Number)
    const rows = [...element.querySelectorAll<HTMLElement>('[data-variant="think"]')]
    const mappedRows = new Map<number, HTMLElement>()
    rows.forEach((row, order) => { if (indices[order] !== undefined) mappedRows.set(indices[order]!, row) })
    disclosureRows.current = mappedRows
    let disposed = false
    const inspect = () => {
      if (disposed) return
      const hidden = hiddenAncestor(element)
      setHidden(previous => previous === hidden ? previous : hidden)
      setCollapsed(previous => {
        const next = new Set(previous.filter(index => blocksRef.current[index]?.kind === 'reasoning'))
        rows.forEach((row, order) => {
          const index = indices[order]
          if (index === undefined) return
          if (!row.hasAttribute('data-expanded') || hiddenAncestor(row)) next.add(index)
          else next.delete(index)
        })
        const sorted = [...next].sort((left, right) => left - right)
        return previous.length === sorted.length && previous.every((index, order) => index === sorted[order]) ? previous : sorted
      })
    }
    // Automatic expansion uses the official passive effect. Inspect after that
    // commit, so a just-mounted auto-opening row is not synchronized prematurely.
    const changed = () => { queueMicrotask(inspect) }
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(changed)
    for (const row of rows) {
      observer?.observe(row, { attributes: true, attributeFilter: ['data-expanded'] })
      for (let parent = row.parentElement; parent !== null && parent !== element; parent = parent.parentElement) {
        observer?.observe(parent, { attributes: true, attributeFilter: ['hidden', 'data-turn-process-inline'] })
      }
    }
    // FollowHost changes internal transform styles each frame. Only external
    // containers can fold this whole seat; do not turn scrolling into a scan.
    for (let parent: HTMLElement | null = element; parent !== null; parent = parent.parentElement) {
      observer?.observe(parent, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] })
    }
    changed()
    return () => {
      disposed = true
      observer?.disconnect()
      if (disclosureRows.current === mappedRows) disclosureRows.current = new Map()
    }
  }, [root, shape, active])
}

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
  const baseScope = useMemo(() => relayScope(node, owner.sessionId), [node.key, node.anchorSeq, node.data.turn, node.data.step, owner.sessionId])
  const recoveryKey = relayTurnKey(baseScope)
  const part = groupPart === 'reasoning' ? 'reasoning' : 'response'
  const recoveryPosition = [baseScope.step, baseScope.order, groupPart === 'reasoning' ? 0 : 1] as const
  const recoveringScope = isBackgroundRecoveryScope(recoveryKey, recoveryPosition)
  const [recoveryEpoch, setRecoveryEpoch] = useState<number | undefined>(() => {
    const activeEpoch = streamRelay.recoveryEpoch(recoveryKey)
    return recoveringScope ? activeEpoch ?? 0 : undefined
  })
  const scope = useMemo(() => ({ ...baseScope, recoveryEpoch }), [baseScope, recoveryEpoch])
  const queuedOnMount = streamRelay.recoveryEpoch(recoveryKey) === undefined && streamRelay.isBlocked(baseScope, part)
  const seenLive = useRef(live || recoveringScope || queuedOnMount)
  if (live || recoveringScope) seenLive.current = true
  const segments = useMemo(() => assistantTextSegments(node.data.blocks, groupPart), [node.data.blocks, groupPart])
  const source = projectionCache(segments).source
  const [recoveryBacklog, setRecoveryBacklog] = useState(() => !reduced && node.data.status !== 'interrupted'
    && recoveringScope && countChars(source) > LARGE_RECOVERY_BACKLOG_CHARS)
  // A resumed seat must never auto-open its reasoning, whatever the backlog
  // size. Latch the recovery scope (the shared recovery map is mutable, so a
  // mid-drain snapshot can drop to `false`) together with any large recovery
  // backlog, so fast-forwarding a collapsed block to "drained" cannot re-open
  // it. The latch resets only when this seat unmounts (a new turn/step seat).
  const recoveryDisclosure = useRef(reduced ? false : (recoveringScope || recoveryBacklog))
  if (!reduced && (recoveringScope || recoveryBacklog)) recoveryDisclosure.current = true
  const root = useRef<HTMLDivElement>(null)
  const [collapsedReasoning, setCollapsedReasoning] = useState<readonly number[]>(() => !preferences.thinkAutoExpand
    ? node.data.blocks.flatMap((block, index) => block.kind === 'reasoning' ? [index] : []) : [])
  const [detailsHidden, setDetailsHidden] = useState(false)
  const disclosureRows = useRef(new Map<number, HTMLElement>())
  const skipPlan = useMemo(() => {
    const collapsed = new Set(collapsedReasoning)
    const ranges: (readonly [number, number])[] = []
    const guards = new Map<number, { blockIndex: number; prefixOnly: boolean }>()
    let offset = 0
    segments.segments.forEach((segment, index) => {
      const start = offset
      offset += countChars(segment)
      const blockIndex = segments.blockIndices[index]!
      const block = node.data.blocks[blockIndex]
      const invisibleReasoning = block?.kind === 'reasoning' && !hasVisibleReasoning(segment)
      if (detailsHidden || collapsed.has(blockIndex) || invisibleReasoning) {
        ranges.push([start, offset])
        guards.set(start, { blockIndex, prefixOnly: invisibleReasoning })
      } else if (block?.kind === 'reasoning') {
        const hiddenPrefix = reasoningDisplayStart(segment)
        if (hiddenPrefix > 0) {
          ranges.push([start, start + countChars(segment.slice(0, hiddenPrefix))])
          guards.set(start, { blockIndex, prefixOnly: true })
        }
      }
    })
    return { ranges, guards }
  }, [segments, collapsedReasoning, detailsHidden, node.data.blocks])
  const canSkipRange = useCallback((start: number) => {
    const guard = skipPlan.guards.get(start)
    if (guard?.prefixOnly) return true
    const element = root.current
    if (element === null || !element.isConnected) return false
    if (hiddenAncestor(element)) return true
    if (guard === undefined || node.data.blocks[guard.blockIndex]?.kind !== 'reasoning') return false
    const row = disclosureRows.current.get(guard.blockIndex)
    // Opening and an incoming chunk can commit before the observer's React
    // state update. Never synchronize new visible text from a stale range.
    if (row === undefined || !row.isConnected) return !preferences.thinkAutoExpand
    return !row.hasAttribute('data-expanded') || hiddenAncestor(row)
  }, [skipPlan, node.data.blocks, preferences.thinkAutoExpand])
  const speed = useRef(35)
  const revealed = useRef(0)
  const scale = useRef(1)
  const presentationKey = JSON.stringify([scope.session, scope.turn, scope.step, scope.node, part])
  const [restored] = useState(() => assistantProgress.read(presentationKey, source))
  const committed = useRef(restored ?? (seenLive.current ? '' : source))
  // Only live/new backlog participates; an already presented historical row
  // cannot be turned back into a stream by an unrelated predecessor.
  const animate = seenLive.current && !reduced && node.data.status !== 'interrupted'
  const subscribeTool = useCallback((listener: () => void) => live
    ? streamRelay.subscribeTool(scope, listener) : () => {}, [live, scope])
  const toolPresent = useSyncExternalStore(subscribeTool,
    () => live && streamRelay.hasTool(scope), () => false)
  const toolHandoff = !preferences.keepStreamOnToolCall
    && (toolPresent || node.data.blocks.some(block => block.kind === 'tool-call'))
  const admissionHold = useRef(animate)
  const hold = useRef(false)
  hold.current = admissionHold.current || (animate && source !== committed.current && streamRelay.isBlocked(scope, part))
  const smoothed = useSmoothStreamContent(source, {
    enabled: animate,
    backgroundRecovery: preferences.backgroundRecovery,
    recoveryKey: seenLive.current ? recoveryKey : undefined,
    recoveryPosition,
    replayOnEnable: false,
    initialDisplayedContent: restored,
    resumeOnMount: restored !== undefined,
    skipRanges: skipPlan.ranges,
    canSkipRange,
    onRecoveryBacklogChange: setRecoveryBacklog,
    initialRecoveryEpoch: recoveryEpoch,
    // Restoring a cached prefix also uses local playback, but only background
    // recovery may promote that playback above ordinary predecessor leases.
    onRecoveryBatchChange: epoch => setRecoveryEpoch(epoch === undefined
      || isBackgroundRecoveryScope(recoveryKey, recoveryPosition)
      || streamRelay.recoveryEpoch(recoveryKey) !== undefined ? epoch : undefined),
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
  const sourceOrder = blockSourceOrder(node, groupPart, shown)
  const activeScope = useMemo(() => sourceOrder === undefined ? scope : { ...scope, sourceOrder }, [scope, sourceOrder])
  const admitted = usePresentationAdmission(activeScope, part, animate, pending, root,
    restored !== undefined && restored !== '', presentationOwnerKey(baseScope, part))
  admissionHold.current = !admitted
  const subscribeBlocked = useCallback((listener: () => void) => pending
    ? streamRelay.subscribeBlocked(activeScope, part, listener) : () => {}, [pending, activeScope, part])
  const relayBlocked = useSyncExternalStore(subscribeBlocked,
    () => pending && streamRelay.isBlocked(activeScope, part), () => false)
  const blocked = !admitted || relayBlocked
  hold.current = blocked
  const ownsLiveTail = live && !toolPresent && !node.data.blocks.some(block => block.kind === 'tool-call')
    && (groupPart !== 'reasoning' || node.data.blocks.at(-1)?.kind === 'reasoning')
  const typing = !toolHandoff && (ownsLiveTail || pending)
  useLayoutEffect(() => {
    committed.current = shown
    if (seenLive.current) assistantProgress.remember(presentationKey, shown)
  }, [presentationKey, shown])
  const lease = useRef<symbol | null>(null)
  useLayoutEffect(() => {
    if (!pending || !admitted) return
    const token = streamRelay.acquire(activeScope, part, true)
    lease.current = token
    return () => {
      streamRelay.release(token)
      if (lease.current === token) lease.current = null
    }
  }, [activeScope, part, pending, admitted])
  const blocks = useMemo(() => animate && !toolHandoff
    ? projectAssistantPresentation(node.data.blocks, segments, shown)
    : node.data.blocks, [animate, toolHandoff, node.data.blocks, segments, shown])
  useCollapsedReasoning(root, blocks, animate, disclosureRows, setCollapsedReasoning, setDetailsHidden)
  const reasoningPending = blocks.some((block, index) => block.kind === 'reasoning'
    && block.text !== (node.data.blocks[index] as { text?: string } | undefined)?.text)
  const reasoningTyping = !toolHandoff && (reasoningPending
    || (live && !toolPresent && node.data.blocks.at(-1)?.kind === 'reasoning'))
  // Ordinary live reasoning keeps the usual auto-expand policy. A background
  // resume never auto-opens: the latch above stays set until this seat is
  // replaced, so a collapsed block cannot reopen mid-catch-up. The disclosure
  // hook still honours manual choices.
  const useDisclosure = useAutomaticDisclosure(owner.useDisclosure, preferences.thinkAutoExpand && !recoveryDisclosure.current, reasoningTyping && !blocked)
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
      data-smooth-stream-phase={blocked ? 'waiting' : typing ? 'typing' : 'settled'}
      data-smooth-stream-typing={!blocked && typing ? 'true' : undefined}>
      <FollowHost active={!blocked && typing && !reduced} speedCpsRef={speed} revealedCharsRef={revealed}
        revealScaleRef={scale} controlScroll={controlScroll} predictive={ownsLiveTail}>
        {admitted ? createElement(Inner, adapted) : null}
      </FollowHost>
    </div>
  )
}

