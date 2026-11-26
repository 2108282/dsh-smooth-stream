import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { BackgroundRecovery } from '../settings.ts'
import { FollowHost } from './FollowHost.tsx'
import { useProgressiveDomText, type DeferredDomTextSource } from './useProgressiveDomText.ts'
import { presentationOwnerKey, usePresentationAdmission } from './usePresentationAdmission.ts'
import { projectToolTreeCallIds, toolTreeCallIds, toolTreeCallSources } from './toolTreePresentation.ts'
import { relayScope, relayTurnKey, streamRelay } from './streamRelay.ts'
import { isBackgroundRecoveryScope } from './backgroundRecovery.ts'
import { hasRecentConversationFollow } from './teleprompterGlide.ts'
import entranceCss from './AgentRowEntrance.module.css'

/** Props forwarded through a follow wrap; extra kit seats pass through. */
export type FollowWrapProps = {
  node?: unknown
  renderSlot?: unknown
} & Record<string, unknown>

/**
 * 判定后端生命周期是否已结算（含未成功加载、中断、执行完毕的卡片）。
 * 是否属于展示历史由独立的呈现记录判定；首次发布的已完成结果仍可能需要排队。
 */
export function isSettledChatNode(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false
  const n = node as Record<string, unknown>
  const data = n.data as Record<string, unknown> | undefined
  if (data !== undefined && typeof data === 'object') {
    // 助手卡片已结算或因错误/停止而中断
    if (data.status === 'settled' || data.status === 'interrupted') return true
    // 工具卡片已产出最终执行结果
    if (data.root !== null && typeof data.root === 'object') {
      const root = data.root as Record<string, unknown>
      if (root.kind === 'tool-result' || ('result' in root && root.result !== undefined)) return true
      if ('state' in root && (root.state === 'ok' || root.state === 'error' || root.state === 'stopped')) return true
    }
    // 命令卡片已执行完毕（无论是 ok 还是 error）
    if (data.command !== null && typeof data.command === 'object') {
      const cmd = data.command as Record<string, unknown>
      if (cmd.outcome !== null && cmd.outcome !== undefined) return true
    }
    if ('outcome' in data && data.outcome !== null && data.outcome !== undefined) return true
    // 模型重试已结束
    if (data.current !== null && typeof data.current === 'object') {
      const cur = data.current as Record<string, unknown>
      if (cur.retryState !== undefined && cur.retryState !== 'scheduled') return true
    }
    if (data.state === 'ok' || data.state === 'error' || data.state === 'stopped') return true
  }
  const location = n.location as Record<string, unknown> | undefined
  if (location !== undefined && typeof location === 'object') {
    if (location.kind === 'step' && location.step !== null && typeof location.step === 'object') {
      if ((location.step as { status?: string }).status === 'closed') return true
    }
    if (location.kind === 'turn' && location.turn !== null && typeof location.turn === 'object') {
      if ((location.turn as { status?: string }).status === 'closed') return true
    }
  }
  return false
}

function isInterruptedChatNode(node: unknown): boolean {
  if (node === null || typeof node !== 'object' || !('data' in node)) return false
  const data = node.data
  if (data === null || typeof data !== 'object') return false
  if ('status' in data && data.status === 'interrupted') return true
  if ('state' in data && data.state === 'stopped') return true
  return 'root' in data && data.root !== null && typeof data.root === 'object'
    && 'state' in data.root && data.root.state === 'stopped'
}

function openAgentLocation(node: unknown): boolean {
  if (node === null || typeof node !== 'object' || !('location' in node)) return false
  const location = (node as { location: unknown }).location
  if (location === null || typeof location !== 'object' || !('kind' in location)) return false
  const kind = (location as { kind: unknown }).kind
  if (!('turn' in location)) return false
  const turn = (location as { turn: unknown }).turn
  if (turn === null || typeof turn !== 'object' || !('status' in turn)) return false
  if (kind === 'turn') return (turn as { status: unknown }).status === 'open'
  if (kind !== 'step' || !('step' in location)) return false
  const step = (location as { step: unknown }).step
  return step !== null
    && typeof step === 'object'
    && 'status' in step
    && (step as { status: unknown }).status === 'open'
}

/**
 * True while a Chat node has an explicitly unfinished lifecycle: an
 * assistant/workflow `status: 'running'` payload, a Tool root that has not
 * settled (`kind` absent), or a model-retry whose current attempt is still
 * `scheduled`.
 */
export function isGrowingChatNode(node: unknown): boolean {
  if (isSettledChatNode(node)) return false
  if (node === null || typeof node !== 'object' || !('data' in node)) return false
  const data = (node as { data: unknown }).data
  if (data === null || typeof data !== 'object') return false
  if ('status' in data && (data as { status: unknown }).status === 'running') return true
  if (
    'kind' in data
    && (data as { kind: unknown }).kind === 'command'
    && 'outcome' in data
    && (data as { outcome: unknown }).outcome === null
  ) return true
  if ('command' in data) {
    const command = (data as { command: unknown }).command
    if (
      command !== null
      && typeof command === 'object'
      && 'outcome' in command
      && (command as { outcome: unknown }).outcome === null
    ) return true
  }
  if ('root' in data) {
    const root = (data as { root: unknown }).root
    if (root !== null && typeof root === 'object' && !('kind' in root)) return true
  }
  if ('current' in data) {
    const current = (data as { current: unknown }).current
    if (
      current !== null
      && typeof current === 'object'
      && 'retryState' in current
      && (current as { retryState: unknown }).retryState === 'scheduled'
    ) return true
  }
  return false
}

/**
 * True for any Agent-owned Chat row in the currently open turn/step.
 * Settled historical cards are unconditionally excluded.
 */
export function isFollowableChatNode(node: unknown): boolean {
  if (isSettledChatNode(node)) return false
  return isGrowingChatNode(node) || openAgentLocation(node)
}

/**
 * True when a newly mounted Agent-owned row belongs to the current open
 * Turn/Step, or is itself an unresolved growing lifecycle.
 */
export function shouldAnimateChatNodeEntrance(node: unknown): boolean {
  return isFollowableChatNode(node)
}

/** Runtime-only fallback for unknown or terminal rows at the active flow tip. */
function liveAgentTailMode(root: HTMLElement): 'turn' | 'handoff' | null {
  const port = root.closest<HTMLElement>('[data-conversation-scroll]')
  if (port === null) return null
  const row = root.closest<HTMLElement>('[data-chat-flow-key]')
  if (row !== null) {
    let sibling = row.nextElementSibling
    while (sibling !== null) {
      if (sibling instanceof HTMLElement && sibling.hasAttribute('data-chat-flow-key')) return null
      sibling = sibling.nextElementSibling
    }
  }
  const flow = root.closest<HTMLElement>('[data-chat-flow]')
  const hasTurnStatus = flow !== null && [...flow.children].some(child =>
    child instanceof HTMLElement
    && child.getAttribute('role') === 'status'
    && !child.hasAttribute('data-chat-flow-key'))
  if (hasTurnStatus) return 'turn'
  return hasRecentConversationFollow(port) ? 'handoff' : null
}

/** Presentation identity survives regrouping/session remounts without retaining DOM. */
interface ToolPresentation {
  calls: Set<string>
  text: Map<string, string[]>
}
interface FrozenCall {
  epoch: number
  source: Record<string, unknown>
  locked: boolean
}
const presentedTools = new Map<string, ToolPresentation>()
const PRESENTED_TOOL_LIMIT = 512
export function clearToolPresentationLedger(): void { presentedTools.clear() }
export function hasPresentedToolNode(node: unknown, sessionId?: unknown): boolean {
  const scope = relayScope(node, sessionId)
  return presentedTools.has(JSON.stringify([scope.session, scope.turn, scope.node]))
}
function sameCallPayload(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left).filter(key => key !== 'subCalls')
  const other = Object.keys(right).filter(key => key !== 'subCalls')
  return keys.length === other.length && keys.every(key => left[key] === right[key])
}
function rememberTool(key: string, presentation: ToolPresentation): void {
  presentedTools.delete(key)
  presentedTools.set(key, presentation)
  if (presentedTools.size > PRESENTED_TOOL_LIMIT) presentedTools.delete(presentedTools.keys().next().value!)
}

/**
 * Wrap a prior Agent Chat renderer so its entrance and later growth share
 * conversation follow. Presentation stays with the wrapped component; kit
 * seats (`renderSlot`, locale, inject) pass through unchanged.
 */
export function wrapFollowNodeView(
  Inner: ComponentType<FollowWrapProps>,
  useControlScroll?: () => boolean,
  useRecoveryMode?: () => BackgroundRecovery,
) {
  return function TypewriterFollowNodeView(props: FollowWrapProps) {
    const controlScroll = useControlScroll?.() ?? true
    const recoveryMode = useRecoveryMode?.() ?? 'catch-up'
    const speedCpsRef = useRef(35)
    const hostRef = useRef<HTMLDivElement>(null)
    const isSettled = isSettledChatNode(props.node)
    const growing = !isSettled && isGrowingChatNode(props.node)
    const baseScope = useMemo(() => relayScope(props.node, props.sessionId), [props.node, props.sessionId])
    const recoveryKey = relayTurnKey(baseScope)
    const nodeKind = props.node !== null && typeof props.node === 'object' && 'kind' in props.node
      ? props.node.kind : undefined
    const toolPresence = nodeKind === 'tool-call'
      || (props.node !== null && typeof props.node === 'object' && 'data' in props.node
        && props.node.data !== null && typeof props.node.data === 'object' && 'root' in props.node.data)
    const part = toolPresence ? 'tool' : 'output'
    const recoveryPosition = [baseScope.step, baseScope.order, 2] as const
    const recoveringScope = isBackgroundRecoveryScope(recoveryKey, recoveryPosition)
    const [recoveryEpoch, setRecoveryEpoch] = useState<number | undefined>(() => {
      const activeEpoch = streamRelay.recoveryEpoch(recoveryKey)
      return recoveringScope ? activeEpoch ?? 0 : undefined
    })
    const scope = useMemo(() => ({ ...baseScope, recoveryEpoch }), [baseScope, recoveryEpoch])
    const presentationKey = scope.node === 'unknown' ? undefined : JSON.stringify([scope.session, scope.turn, scope.node])
    const priorPresentation = useRef(presentationKey === undefined ? undefined : presentedTools.get(presentationKey)).current
    const presentation = useRef<ToolPresentation>(priorPresentation ?? { calls: new Set(), text: new Map() }).current
    const revealInitialRef = useRef(priorPresentation === undefined)
    const revealDomInitial = useRef(revealInitialRef.current || presentation.text.size > 0).current
    const queuedOnMount = useRef(revealInitialRef.current
      && streamRelay.recoveryEpoch(recoveryKey) === undefined
      && streamRelay.isBlocked(baseScope, part)).current
    // A newly published result behind live text or inside recovery is new
    // output even when its backend work has already finished. History stays static.
    const structurallyFollowable = isFollowableChatNode(props.node)
      || (!isSettled && openAgentLocation(props.node))
      || (recoveringScope && revealInitialRef.current)
      || queuedOnMount
    const structuralRef = useRef(structurallyFollowable)
    const [runtimeFollowable, setRuntimeFollowable] = useState(false)
    const runtimePersistentRef = useRef(false)
    const runtimeHandledRef = useRef(false)
    const seenFollowable = useRef(structurallyFollowable)
    if (structurallyFollowable) seenFollowable.current = true
    const settledOpenGrowth = isSettled && seenFollowable.current && openAgentLocation(props.node)
    const followable = !isInterruptedChatNode(props.node)
      && (seenFollowable.current || (!isSettled && runtimeFollowable) || settledOpenGrowth)
    const [revealPending, setRevealPending] = useState(followable && revealInitialRef.current)
    const sourceNode = props.node !== null && typeof props.node === 'object' ? props.node as Record<string, unknown> : undefined
    const sourceData = sourceNode?.data !== null && typeof sourceNode?.data === 'object'
      ? sourceNode.data as Record<string, unknown> : undefined
    const sourceRoot = sourceData?.root
    const sourceCallIds = useMemo(() => toolTreeCallIds(sourceRoot), [sourceRoot])
    const sourceCalls = useMemo(() => toolTreeCallSources(sourceRoot), [sourceRoot])
    const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(() => new Set(presentation.calls))
    const visibleCallIds = useMemo(() => new Set([...visibleIds, ...sourceCallIds.slice(0, 1)]), [visibleIds, sourceCallIds])
    const projectCalls = followable && sourceCallIds.length > 0
    const deferredIds = projectCalls ? sourceCallIds.filter(id => !visibleCallIds.has(id)) : []
    const admittedRef = useRef(false)
    const materializedRef = useRef(!followable || !revealInitialRef.current)
    const waitingRef = useRef(true)
    const frozenCalls = useRef(new Map<string, FrozenCall>())
    const releasedCalls = useRef(new Map<string, number>())
    const lockedSources = new Map<string, Record<string, unknown>>()
    const changedPayloads: string[] = []
    for (const [id, frozen] of frozenCalls.current) {
      const current = sourceCalls.get(id)
      if (!frozen.locked || frozen.epoch !== recoveryEpoch || current === undefined) continue
      lockedSources.set(id, frozen.source)
      if (!sameCallPayload(current, frozen.source)) changedPayloads.push(id)
    }
    const deferredCalls = deferredIds.length > 0 || changedPayloads.length > 0
    const treeRef = useRef({ ids: sourceCallIds, visible: visibleCallIds, calls: sourceCalls, deferredIds, changedPayloads, deferred: deferredCalls })
    treeRef.current = { ids: sourceCallIds, visible: visibleCallIds, calls: sourceCalls, deferredIds, changedPayloads, deferred: deferredCalls }
    const previousLocks = useRef(lockedSources)
    useLayoutEffect(() => {
      if (recoveryEpoch !== undefined) for (const [id, previous] of previousLocks.current) {
        const current = sourceCalls.get(id)
        if (!lockedSources.has(id) && current !== undefined && !sameCallPayload(current, previous)) releasedCalls.current.set(id, recoveryEpoch)
      }
      previousLocks.current = lockedSources
    })
    const [entering, setEntering] = useState(structurallyFollowable)
    const [growthPulse, setGrowthPulse] = useState(false)
    const followableRef = useRef(false)
    const growingRef = useRef(growing)
    const entranceActiveRef = useRef(entering || growthPulse)
    const growthExtentRef = useRef<number | null>(null)
    const mountedRef = useRef(true)
    const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    structuralRef.current = structurallyFollowable
    followableRef.current = followable
    growingRef.current = growing
    entranceActiveRef.current = entering || growthPulse

    // 内存接力棒门禁：检查前序思考或正文是否仍在活跃输出中
    const admitted = usePresentationAdmission(scope, part, followable,
      revealPending || deferredCalls, hostRef, !revealInitialRef.current, presentationOwnerKey(baseScope, part))
    admittedRef.current = admitted
    const participating = growing || revealPending || deferredCalls || (!isSettled && followable)
    const subscribeBlocked = useCallback((listener: () => void) => participating
      ? streamRelay.subscribeBlocked(scope, part, listener) : () => {},
    [participating, scope.session, scope.turn, scope.step, scope.node, scope.order, scope.recoveryEpoch, part])
    const readBlocked = useCallback(() => participating && streamRelay.isBlocked(scope, part),
      [participating, scope.session, scope.turn, scope.step, scope.node, scope.order, scope.recoveryEpoch, part])
    const relayBlocked = useSyncExternalStore(subscribeBlocked, readBlocked, () => false)
    const lease = useRef<symbol | null>(null)
    const pendingRef = useRef(revealPending || deferredCalls)
    pendingRef.current = revealPending || deferredCalls
    // Tool presence is observable before creation (keepStreamOnToolCall), but
    // its text lease must stay inactive until presentation has been admitted.
    const needsLease = participating && (admitted || part === 'tool')
    const updatePending = useCallback((pending: boolean) => {
      // Empty seats cannot retire work before their renderer has committed.
      if (!admittedRef.current || !materializedRef.current) return
      pendingRef.current = pending || treeRef.current.deferred
      setRevealPending(pending)
      if (lease.current !== null) streamRelay.update(lease.current, pendingRef.current)
    }, [])
    useLayoutEffect(() => {
      // Reserve in layout before any frame can reveal. Running backend work
      // does not retain the baton once its currently available text is drained.
      if (!needsLease) return
      const token = streamRelay.acquire(scope, part, admitted && pendingRef.current)
      lease.current = token
      return () => {
        streamRelay.release(token)
        if (lease.current === token) lease.current = null
      }
    }, [scope.session, scope.turn, scope.step, scope.node, scope.order, scope.recoveryEpoch, part, needsLease])
    useLayoutEffect(() => {
      if (lease.current !== null) streamRelay.update(lease.current, admitted && pendingRef.current)
    }, [admitted, revealPending, deferredCalls])

    // DOM 前驱时序门禁：仅检查并监听紧邻的前驱卡片，切断全容器广播风暴
    const [precedingTyping, setPrecedingTyping] = useState(false)
    // A tool may settle before its preceding assistant has drained. Completion
    // never bypasses that queue; historical rows have no preceding live lease.
    const isUnsettled = participating && (relayBlocked || growing || structurallyFollowable)

    useLayoutEffect(() => {
      if (!isUnsettled) {
        setPrecedingTyping(false)
        return
      }
      const root = hostRef.current
      if (!root) return
      const flowItem = root.closest('[data-chat-flow-key]')
      if (!flowItem) return

      // 仅定位紧邻的上一张卡片（O(1) 局部定位）
      let prev: HTMLElement | null = null
      let cur = flowItem.previousElementSibling
      while (cur instanceof HTMLElement) {
        if (cur.hasAttribute('data-chat-flow-key')) {
          prev = cur
          break
        }
        cur = cur.previousElementSibling
      }

      if (!prev) {
        setPrecedingTyping(false)
        return
      }

      const checkPreceding = () => {
        if (!prev) return false
        // Native rows publish scoped leases, including unmount cleanup. Do not
        // duplicate that gate from DOM producer markers or a different Session.
        const managed = prev.querySelector('[data-smooth-stream-phase]')
        if (managed !== null) return false
        return prev.querySelector('[data-streaming], [data-smooth-stream-typing="true"]') !== null
      }

      const isTyping = checkPreceding()
      setPrecedingTyping(isTyping)
      if (!isTyping || typeof MutationObserver === 'undefined') return

      // 仅监听紧邻前驱，且一旦前驱完成立即销毁 observer，彻底杜绝 N^2 全局监听
      const observer = new MutationObserver(() => {
        const stillTyping = checkPreceding()
        setPrecedingTyping(stillTyping)
        if (!stillTyping) {
          observer.disconnect()
        }
      })
      observer.observe(prev, {
        attributes: true,
        childList: true,
        attributeFilter: ['data-streaming', 'data-smooth-stream-typing', 'data-smooth-stream-phase'],
        subtree: true,
      })
      return () => observer.disconnect()
    }, [isUnsettled, relayBlocked, scope.session, scope.turn, scope.step, scope.node])

    // Scoped leases release on drain/interruption/unmount. There is no elapsed
    // time that can prove the preceding text really committed to the screen.
    const waiting = !admitted || relayBlocked || (isUnsettled && precedingTyping)
    waitingRef.current = waiting
    // The unmanaged predecessor DOM gate is discovered from the empty Host
    // seat. Once created, preserve the actual Inner across subsequent pauses.
    if (!waiting) materializedRef.current = true
    useLayoutEffect(() => {
      if (!materializedRef.current) return
      for (const id of projectCalls ? visibleCallIds : sourceCallIds) presentation.calls.add(id)
      if (presentationKey !== undefined) rememberTool(presentationKey, presentation)
    }, [admitted, waiting, presentationKey, presentation, projectCalls, visibleCallIds, sourceCallIds])

    // The initial entrance remains armed while admission is pending. Starting
    // it again after creation would race the child's onEntranceSettled callback
    // and retain scroll ownership after a zero-height/short entrance drains.

    const finishRuntimeReveal = useCallback(() => {
      if (structuralRef.current || runtimePersistentRef.current) return
      runtimeHandledRef.current = true
      setRuntimeFollowable(false)
    }, [])

    const deferredSource = useMemo<DeferredDomTextSource>(() => ({
      presentations: presentation.text,
      hasPending(epoch) {
        const tree = treeRef.current
        return tree.deferred && (epoch === undefined
          || [...tree.deferredIds, ...tree.changedPayloads].some(id => frozenCalls.current.get(id)?.epoch === epoch))
      },
      freeze(epoch) {
        const tree = treeRef.current
        for (const id of tree.ids) {
          const source = tree.calls.get(id)
          if (source !== undefined && !frozenCalls.current.has(id)) frozenCalls.current.set(id, {
            epoch, source, locked: !materializedRef.current || !tree.visible.has(id),
          })
        }
      },
      epochForCall: id => frozenCalls.current.get(id)?.epoch,
      adoptingEpoch: id => releasedCalls.current.get(id),
      didObserve: () => { releasedCalls.current.clear() },
      onDrained(epoch) {
        const tree = treeRef.current
        if (!tree.deferred || !admittedRef.current || waitingRef.current) return epoch
        const id = epoch === undefined ? tree.deferredIds[0]
          : tree.deferredIds.find(candidate => frozenCalls.current.get(candidate)?.epoch === epoch)
        if (id === undefined && epoch !== undefined) return epoch + 1
        if (id === undefined) return epoch
        // Reserve the next commit before its text can be discovered by the
        // observer, including an icon-only call with no Text nodes at all.
        updatePending(true)
        setVisibleIds(current => new Set([...current, id]))
        return epoch
      },
    }), [presentation, updatePending])
    const updateRecoveryEpoch = useCallback((epoch: number | undefined) => {
      if (epoch === undefined) {
        frozenCalls.current.clear()
        releasedCalls.current.clear()
      }
      setRecoveryEpoch(epoch)
    }, [])
    const projectedRoot = projectCalls ? projectToolTreeCallIds(sourceRoot, visibleCallIds, lockedSources) : sourceRoot
    const adapted = useMemo(() => projectedRoot === sourceRoot ? props : {
      ...props, node: { ...sourceNode, data: { ...sourceData, root: projectedRoot } },
    }, [props, projectedRoot, sourceRoot, sourceNode, sourceData])

    useProgressiveDomText(
      hostRef,
      followable && (!isSettled || settledOpenGrowth || revealPending || deferredCalls),
      revealDomInitial,
      speedCpsRef,
      runtimeFollowable ? finishRuntimeReveal : undefined,
      updatePending,
      waiting,
      recoveryMode,
      followable && (growing || revealPending || deferredCalls) ? recoveryKey : undefined,
      recoveryPosition,
      growing || settledOpenGrowth || revealPending || deferredCalls || (!isSettled && followable),
      updateRecoveryEpoch,
      recoveryEpoch,
      projectCalls ? deferredSource : undefined,
    )

    useLayoutEffect(() => {
      if (structurallyFollowable || isSettled) return
      const root = hostRef.current
      if (root === null) return
      const mode = liveAgentTailMode(root)
      if (runtimeFollowable) {
        if (runtimePersistentRef.current && mode !== 'turn') {
          runtimePersistentRef.current = false
          runtimeHandledRef.current = true
          setRuntimeFollowable(false)
        }
        return
      }
      if (runtimeHandledRef.current || mode === null) return
      runtimePersistentRef.current = mode === 'turn'
      setRuntimeFollowable(true)
      setEntering(false)
    }, [runtimeFollowable, structurallyFollowable, isSettled])

    const finishEntrance = useCallback(() => {
      growthExtentRef.current = null
      if (pulseTimerRef.current !== null) {
        clearTimeout(pulseTimerRef.current)
        pulseTimerRef.current = null
      }
      setEntering(false)
      setGrowthPulse(false)
    }, [])

    const onGrowth = useCallback((deltaPx: number) => {
      if (
        !mountedRef.current
        || !followableRef.current
        || growingRef.current
        || entranceActiveRef.current
        || (isSettled && !settledOpenGrowth)
      ) return
      growthExtentRef.current = deltaPx
      setGrowthPulse(true)
      if (pulseTimerRef.current !== null) clearTimeout(pulseTimerRef.current)
      pulseTimerRef.current = setTimeout(() => {
        pulseTimerRef.current = null
        setGrowthPulse(false)
      }, 1200)
    }, [isSettled, settledOpenGrowth])

    useEffect(() => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
        if (pulseTimerRef.current !== null) clearTimeout(pulseTimerRef.current)
      }
    }, [])

    useLayoutEffect(() => {
      const el = hostRef.current
      if (!el) return
      const card = el.closest('[data-chat-flow-key]')
      const settled = !revealPending && !waiting && (isSettled || (!growing && !entering && !growthPulse))
      if (settled) {
        el.setAttribute('data-smooth-stream-settled', 'true')
        if (card instanceof HTMLElement) card.setAttribute('data-smooth-stream-settled', 'true')
      } else {
        el.removeAttribute('data-smooth-stream-settled')
        if (card instanceof HTMLElement) card.removeAttribute('data-smooth-stream-settled')
      }
    }, [isSettled, growing, entering, growthPulse, waiting, revealPending])

    return (
      <div data-smooth-stream-phase={waiting ? 'waiting' : revealPending ? 'typing' : 'settled'} data-smooth-stream-typing={revealPending ? 'true' : undefined} style={{ transition: 'opacity 0.15s ease' }}>
        <FollowHost
          active={!waiting && revealPending}
          entrance={!waiting && (entering || growthPulse)}
          onEntranceSettled={finishEntrance}
          onGrowth={followable && !waiting && (!isSettled || settledOpenGrowth) ? onGrowth : undefined}
          entranceExtentRef={growthExtentRef}
          speedCpsRef={speedCpsRef}
          controlScroll={controlScroll}
          predictive={false}
          hostRef={hostRef}
          className={entranceCss.surface}
          entranceActive={!waiting && (entering || growthPulse)}
        >
          {materializedRef.current ? createElement(Inner, adapted) : null}
        </FollowHost>
      </div>
    )
  }
}
