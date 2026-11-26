import { act, cleanup, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createElement, useLayoutEffect, useRef, type ReactElement, type RefObject } from 'react'
import type { ChatFlowSlotProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { GroupKey, NodeKey } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FlowPresentationAdapter, clearFlowPresentationState, type SettingsSource,
} from '../src/client/flowPresentationAdapter.tsx'
import { clearToolPresentationLedger, wrapFollowNodeView } from '../src/client/TypewriterToolNodeView.tsx'
import { streamRelay } from '../src/client/streamRelay.ts'
import { DEFAULT_STREAM_SETTINGS, type BackgroundRecovery } from '../src/settings.ts'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => {
  cleanup()
  clearFlowPresentationState()
  clearToolPresentationLedger()
  streamRelay.clearAll()
  vi.unstubAllGlobals()
})

const groupKey = 'process:1' as GroupKey
const member = {
  key: 'tool:1', kind: 'tool-call', anchorSeq: 2,
  data: { turn: 1, step: 1, root: {}, status: 'running' },
  location: { kind: 'step', turn: { turn: 1, status: 'open' }, step: { step: 1, status: 'open' } },
}
const group = {
  key: groupKey,
  data: { turn: 1, closed: false, summary: { counts: [], running: 'tools', runningDetail: '' } },
  members: [{ kind: 'node' as const, key: member.key }],
}

const nodes = new Map([[member.key, member]])
const groups = new Map([[groupKey, group]])
const useChatNode = ((key: string, selector?: (value: unknown) => unknown) => {
  const value = nodes.get(key)
  return selector === undefined ? value : selector(value)
}) as ChatFlowSlotProps['useChatNode']
const useChatGroup = ((key: GroupKey, selector?: (value: typeof group | undefined) => unknown) => {
  const value = groups.get(key)
  return selector === undefined ? value : selector(value)
}) as ChatFlowSlotProps['useChatGroup']

const groupRootInitializations: boolean[] = []
const groupHeaderInitializations: boolean[] = []
const useGroupAction = ((hidden: boolean, reveal: () => void) => {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    groupRootInitializations.push(ref.current !== null)
    if (hidden) reveal()
  }, [hidden, reveal])
  return ref
}) as ChatFlowSlotProps['useGroupAction']
const useGroupHeaderAction = ((ref: RefObject<HTMLElement | null>, hidden: boolean) => {
  useLayoutEffect(() => {
    groupHeaderInitializations.push(ref.current !== null)
  }, [ref, hidden])
}) as ChatFlowSlotProps['useGroupHeaderAction']

function GroupSeat({ props }: { props: ChatFlowSlotProps }) {
  const snapshot = props.useChatGroup(groupKey, value => value)
  const rootRef = props.useGroupAction(false, () => {})
  const headerRef = useRef<HTMLElement>(null)
  props.useGroupHeaderAction(headerRef, false)
  if (snapshot === undefined) return null
  return createElement('div', { ref: rootRef }, createElement('div', {
    ref: headerRef,
    'data-testid': 'group-header',
  }, createElement('svg', { 'data-testid': 'group-icon' }), 'process'))
}

function TestFlow(props: ChatFlowSlotProps) {
  return createElement('main', { 'data-tail-kind': props.entries.at(-1)?.kind }, ...props.entries.map(entry => entry.kind === 'group'
    ? createElement(GroupSeat, { key: entry.key, props })
    : null))
}

const replayText = 'ordered tool text '.repeat(3)
const ReplayRow = wrapFollowNodeView(props => createElement('article', {
  'data-node-id': (props.node as { key: string }).key,
}, createElement('svg'), replayText), () => false)
function ReplayNode({ nodeKey, props }: { nodeKey: string; props: ChatFlowSlotProps }) {
  const node = props.useChatNode(nodeKey, value => value)
  return node === undefined ? null : createElement(ReplayRow, { node, sessionId: props.sessionId })
}
function ReplayGroup({ groupKey: key, props }: { groupKey: GroupKey; props: ChatFlowSlotProps }) {
  const snapshot = props.useChatGroup(key, value => value)
  return snapshot === undefined ? null : createElement('section', { 'data-group-id': key },
    createElement('header', null, createElement('svg'), key),
    ...snapshot.members.map(member => createElement(ReplayNode, { key: member.key, nodeKey: member.key, props })))
}
function ReplayFlow(props: ChatFlowSlotProps) {
  return createElement('main', null, ...props.entries.map(entry => entry.kind === 'node'
    ? createElement(ReplayNode, { key: entry.key, nodeKey: entry.key, props })
    : createElement(ReplayGroup, { key: entry.key, groupKey: entry.key, props })))
}

const activeSettings = { ...DEFAULT_STREAM_SETTINGS, enabled: true }
const settings: SettingsSource = {
  subscribe: () => () => {},
  getSnapshot: () => activeSettings,
}

function flowProps(): ChatFlowSlotProps {
  return {
    sessionId: 'group-session',
    entries: [{ kind: 'group', key: groupKey }],
    useChatNode,
    useChatGroup,
    useGroupAction,
    useGroupHeaderAction,
  } as unknown as ChatFlowSlotProps
}

async function installedFlow() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: {
    'conversation.chat.flow': { kind: 'single', scope: 'session' },
    'conversation.chat.node': { kind: 'keyed', scope: 'session' },
  } } as never, () => null)
  ctx.slots.register({ name: 'conversation.chat.flow', priority: 20 } as never, TestFlow as never)
  for (const key of ['user', 'turn-process', 'turn-tail', 'tool-call']) {
    ctx.slots.register({ name: 'conversation.chat.node', key } as never, () => null)
  }
  const entry = ctx.slots.entries('conversation.chat.flow')[0]!
  const metadata = entry.options
  const plugin = ctx.plugin({ inject: [...inject], apply })
  await plugin.await()
  return { ctx, entry, metadata, dispose: () => plugin.dispose() }
}

function withNodes(values: readonly (typeof member)[]): ChatFlowSlotProps['useChatNode'] {
  const store = new Map(values.map(value => [value.key, value]))
  return ((key: string, selector?: (value: unknown) => unknown) => {
    const value = store.get(key)
    return selector === undefined ? value : selector(value)
  }) as ChatFlowSlotProps['useChatNode']
}

interface RecoveryCall {
  callId: string
  text: string
  subCalls: RecoveryCall[]
}

function recoveryFlow(mode: BackgroundRecovery) {
  const frames = new Map<number, FrameRequestCallback>()
  let next = 0
  let time = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++next, callback)
    return next
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('performance', { now: () => time })
  const paint = async (count = 1) => {
    for (let index = 0; index < count; index++) await act(async () => {
      const batch = [...frames.values()]
      frames.clear()
      time += 16
      for (const callback of batch) callback(time)
    })
  }
  const created: string[] = []
  function Call({ call }: { call: RecoveryCall }): ReactElement {
    return createElement('div', { 'data-chat-call-id': call.callId },
      createElement('span', { 'data-call-text': call.callId }, call.text),
      ...call.subCalls.map(child => createElement(Call, { key: child.callId, call: child })))
  }
  const Row = wrapFollowNodeView(props => {
    const node = props.node as { key: string; data: { root: RecoveryCall } }
    useLayoutEffect(() => { created.push(node.key) }, [])
    return createElement('article', { 'data-node-id': node.key }, createElement(Call, { call: node.data.root }))
  }, () => false, () => mode)
  function Node({ nodeKey, props }: { nodeKey: string; props: ChatFlowSlotProps }) {
    const node = props.useChatNode(nodeKey, value => value)
    return node === undefined ? null : createElement(Row, { node, sessionId: props.sessionId })
  }
  function Group({ groupKey: key, props }: { groupKey: GroupKey; props: ChatFlowSlotProps }) {
    const snapshot = props.useChatGroup(key, value => value)
    return snapshot === undefined ? null : createElement('section', { 'data-group-id': key },
      createElement('header', null, key),
      ...snapshot.members.map(member => createElement(Node, { key: member.key, nodeKey: member.key, props })))
  }
  function Flow(props: ChatFlowSlotProps) {
    return createElement('main', null, ...props.entries.map(entry => entry.kind === 'group'
      ? createElement(Group, { key: entry.key, groupKey: entry.key, props })
      : createElement(Node, { key: entry.key, nodeKey: entry.key, props })))
  }
  const groupKeys = [groupKey, 'process:recovery-second', 'process:recovery-third'] as GroupKey[]
  const nodeKeys = ['tool:recovery-first', 'tool:recovery-second', 'tool:recovery-third']
  const callIds = ['recovery-first', 'recovery-second', 'recovery-third']
  const sourceGroups = new Map(groupKeys.map((key, index) => [key, {
    ...group, key, members: [{ kind: 'node' as const, key: nodeKeys[index]! }],
  }]))
  const initial = 'seed '.repeat(10)
  const batchA = initial + 'a'.repeat(160)
  const batchB = batchA + 'b'.repeat(160)
  const secondText = 'second group '.repeat(4)
  const thirdText = 'third group '.repeat(4)
  const secondB = secondText + 'new suffix '.repeat(5)
  const childId = 'recovery-second-child-b'
  const childText = 'new subcall from batch B'
  const managedNodeKinds = new Set(['tool-call'])
  const snapshot = (firstText: string, count: number, growSecond = false): ChatFlowSlotProps => ({
    ...flowProps(),
    entries: groupKeys.slice(0, count).map(key => ({ kind: 'group', key })),
    useChatNode: withNodes(nodeKeys.map((key, index) => ({
      ...member, key, anchorSeq: index + 1,
      data: { ...member.data, root: {
        callId: callIds[index]!,
        text: index === 0 ? firstText : index === 1 ? growSecond ? secondB : secondText : thirdText,
        subCalls: index === 1 && growSecond ? [{ callId: childId, text: childText, subCalls: [] }] : [],
      } },
    }))),
    useChatGroup: ((key: GroupKey, selector?: (value: typeof group | undefined) => unknown) => {
      const value = sourceGroups.get(key)
      return selector === undefined ? value : selector(value)
    }) as ChatFlowSlotProps['useChatGroup'],
  })
  const recoverySnapshot = { ...activeSettings, backgroundRecovery: mode }
  const recoverySettings: SettingsSource = {
    subscribe: () => () => {},
    getSnapshot: () => recoverySnapshot,
  }
  const tree = (firstText: string, count: number, growSecond = false) => createElement(FlowPresentationAdapter, {
    Inner: Flow, props: snapshot(firstText, count, growSecond), settings: recoverySettings, managedNodeKinds,
  })
  return {
    paint, tree, created, groupKeys, nodeKeys, callIds,
    initial, batchA, batchB, secondText, secondB, thirdText, childId, childText,
  }
}

describe('ordered process-group presentation', () => {
  it('does not create a group header or SVG until its first member is admitted, then rebinds visibility refs', async () => {
    groupRootInitializations.length = 0
    groupHeaderInitializations.length = 0
    const prior = streamRelay.acquire({
      session: 'group-session', turn: '1', step: 1, node: 'assistant:0', order: 1,
    }, 'response')
    const view = render(createElement(FlowPresentationAdapter, {
      Inner: TestFlow,
      props: flowProps(),
      settings,
      managedNodeKinds: new Set(['tool-call']),
    }))

    expect(view.queryByTestId('group-header')).toBeNull()
    expect(view.container.querySelector('main')?.dataset.tailKind).toBe('group')
    expect(view.container.querySelector('svg')).toBeNull()
    await act(async () => {})
    expect(view.queryByTestId('group-header')).toBeNull()
    expect(groupRootInitializations).toContain(false)
    expect(groupHeaderInitializations).toContain(false)

    await act(async () => { streamRelay.release(prior) })
    expect(view.getByTestId('group-header')).toBeTruthy()
    expect(view.getByTestId('group-icon')).toBeTruthy()
    expect(groupRootInitializations).toContain(true)
    expect(groupHeaderInitializations).toContain(true)
  })

  it('drains root rows and all group members before creating the next group header', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let next = 0
    let time = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++next, callback)
      return next
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    vi.stubGlobal('performance', { now: () => time })
    const paint = async () => {
      await act(async () => {
        const batch = [...frames.values()]
        frames.clear()
        time += 16
        for (const callback of batch) callback(time)
      })
    }
    const source = Array.from({ length: 5 }, (_, index) => ({ ...member, key: `tool:${index}`, anchorSeq: index + 1 }))
    const secondKey = 'process:2' as GroupKey
    const sourceGroups = new Map([
      [groupKey, { ...group, members: source.slice(1, 3).map(node => ({ kind: 'node' as const, key: node.key })) }],
      [secondKey, { ...group, key: secondKey, members: [{ kind: 'node' as const, key: source[3]!.key }] }],
    ])
    const props: ChatFlowSlotProps = {
      ...flowProps(),
      entries: [
        { kind: 'node', key: source[0]!.key as NodeKey },
        { kind: 'group', key: groupKey },
        { kind: 'group', key: secondKey },
        { kind: 'node', key: source[4]!.key as NodeKey },
      ],
      useChatNode: withNodes(source),
      useChatGroup: ((key: GroupKey, selector?: (value: typeof group | undefined) => unknown) => {
        const value = sourceGroups.get(key)
        return selector === undefined ? value : selector(value)
      }) as ChatFlowSlotProps['useChatGroup'],
    }
    const view = render(createElement(FlowPresentationAdapter, {
      Inner: ReplayFlow, props, settings, managedNodeKinds: new Set(['tool-call']),
    }))
    expect(view.container.querySelector('article')).toBeNull()
    expect(view.container.querySelector('header')).toBeNull()
    for (let frame = 0; frame < 240; frame++) {
      await paint()
      const rows = [...view.container.querySelectorAll('article')]
      for (let index = 1; index < rows.length; index++) expect(rows[index - 1]!.textContent).toBe(replayText)
      if (view.container.querySelector(`[data-group-id="${groupKey}"]`) !== null) {
        expect(view.container.querySelector('[data-node-id="tool:0"]')?.textContent).toBe(replayText)
      }
      if (view.container.querySelector(`[data-group-id="${secondKey}"]`) !== null) {
        expect(view.container.querySelector('[data-node-id="tool:2"]')?.textContent).toBe(replayText)
      }
    }
    expect(view.container.querySelectorAll('article')).toHaveLength(5)
    for (const row of view.container.querySelectorAll('article')) expect(row.textContent).toBe(replayText)
  })

  it.each(['catch-up', 'replay'] as const)('admits a new group from recovery batch A before an earlier group reveals its batch B suffix (%s)', async mode => {
    const frames = new Map<number, FrameRequestCallback>()
    let next = 0
    let time = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++next, callback)
      return next
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    vi.stubGlobal('performance', { now: () => time })
    const paint = async (count = 1) => {
      for (let index = 0; index < count; index++) await act(async () => {
        const batch = [...frames.values()]
        frames.clear()
        time += 16
        for (const callback of batch) callback(time)
      })
    }
    const Row = wrapFollowNodeView(props => {
      const node = props.node as { key: string; data: { root: { callId: string; text: string } } }
      return createElement('article', { 'data-node-id': node.key, 'data-chat-call-id': node.data.root.callId }, node.data.root.text)
    }, () => false, () => mode)
    function Node({ nodeKey, props }: { nodeKey: string; props: ChatFlowSlotProps }) {
      const node = props.useChatNode(nodeKey, value => value)
      return node === undefined ? null : createElement(Row, { node, sessionId: props.sessionId })
    }
    function Group({ groupKey: key, props }: { groupKey: GroupKey; props: ChatFlowSlotProps }) {
      const snapshot = props.useChatGroup(key, value => value)
      return snapshot === undefined ? null : createElement('section', { 'data-group-id': key },
        createElement('header', null, key),
        ...snapshot.members.map(member => createElement(Node, { key: member.key, nodeKey: member.key, props })))
    }
    function Flow(props: ChatFlowSlotProps) {
      return createElement('main', null, ...props.entries.map(entry => entry.kind === 'group'
        ? createElement(Group, { key: entry.key, groupKey: entry.key, props })
        : createElement(Node, { key: entry.key, nodeKey: entry.key, props })))
    }
    const secondKey = 'process:recovery-second' as GroupKey
    const firstNodeKey = 'tool:recovery-first'
    const secondNodeKey = 'tool:recovery-second'
    const initial = 'seed '.repeat(10)
    const batchA = initial + 'a'.repeat(160)
    const batchB = batchA + 'b'.repeat(160)
    const secondText = 'second group '.repeat(4)
    const managedNodeKinds = new Set(['tool-call'])
    const sourceGroups = new Map([
      [groupKey, { ...group, members: [{ kind: 'node' as const, key: firstNodeKey }] }],
      [secondKey, { ...group, key: secondKey, members: [{ kind: 'node' as const, key: secondNodeKey }] }],
    ])
    const snapshot = (firstText: string, includeSecond: boolean): ChatFlowSlotProps => ({
      ...flowProps(),
      entries: includeSecond ? [{ kind: 'group', key: groupKey }, { kind: 'group', key: secondKey }]
        : [{ kind: 'group', key: groupKey }],
      useChatNode: withNodes([
        { ...member, key: firstNodeKey, anchorSeq: 1, data: { ...member.data, root: { callId: 'recovery-first', text: firstText, subCalls: [] } } },
        { ...member, key: secondNodeKey, anchorSeq: 2, data: { ...member.data, root: { callId: 'recovery-second', text: secondText, subCalls: [] } } },
      ]),
      useChatGroup: ((key: GroupKey, selector?: (value: typeof group | undefined) => unknown) => {
        const value = sourceGroups.get(key)
        return selector === undefined ? value : selector(value)
      }) as ChatFlowSlotProps['useChatGroup'],
    })
    const recoverySnapshot = { ...activeSettings, backgroundRecovery: mode }
    const recoverySettings: SettingsSource = { subscribe: () => () => {}, getSnapshot: () => recoverySnapshot }
    const tree = (firstText: string, includeSecond: boolean) => createElement(FlowPresentationAdapter, {
      Inner: Flow, props: snapshot(firstText, includeSecond), settings: recoverySettings, managedNodeKinds,
    })
    const view = render(tree(initial, false))
    const shown = (key: string) => view.container.querySelector(`[data-node-id="${key}"]`)?.textContent
    await paint(3)
    const beforeHidden = shown(firstNodeKey)!
    expect(beforeHidden.length).toBeGreaterThan(0)
    expect(beforeHidden.length).toBeLessThan(initial.length)
    await act(async () => { window.dispatchEvent(new Event('pagehide')) })
    view.rerender(tree(batchA, true))
    await act(async () => {})
    expect(shown(firstNodeKey)).toBe(beforeHidden)
    expect(view.container.querySelector(`[data-group-id="${secondKey}"]`)).toBeNull()
    await act(async () => { window.dispatchEvent(new Event('pageshow')) })
    await paint()
    expect(streamRelay.recoveryEpoch('["group-session","1"]')).toBe(0)
    expect(shown(firstNodeKey)!.length).toBeLessThan(batchA.length)
    expect(view.container.querySelector(`[data-group-id="${secondKey}"]`)).toBeNull()
    // This suffix arrives after the foreground snapshot has frozen batch A.
    // The uncreated second group was already present in that original snapshot.
    view.rerender(tree(batchB, true))
    let admittedSecond = false
    for (let frame = 0; frame < 1200; frame++) {
      await paint()
      if (view.container.querySelector(`[data-group-id="${secondKey}"]`) !== null) {
        expect(shown(firstNodeKey)).toBe(batchA)
        admittedSecond = true
        break
      }
      expect(shown(firstNodeKey)!.length).toBeLessThanOrEqual(batchA.length)
    }
    expect(admittedSecond).toBe(true)
    for (let frame = 0; frame < 1200 && shown(secondNodeKey) !== secondText; frame++) {
      expect(shown(firstNodeKey)).toBe(batchA)
      await paint()
    }
    expect(shown(secondNodeKey)).toBe(secondText)
    await paint(1200)
    expect(shown(firstNodeKey)).toBe(batchB)
    expect(shown(secondNodeKey)).toBe(secondText)
    expect(streamRelay.recoveryEpoch('["group-session","1"]')).toBeUndefined()
  })

  it.each(['catch-up', 'replay'] as const)('keeps an uncreated member frozen until the third group from its recovery snapshot drains (%s)', async mode => {
    const fixture = recoveryFlow(mode)
    const { paint, tree, initial, batchA, secondText, secondB, thirdText, childId, childText, groupKeys, callIds } = fixture
    const view = render(tree(initial, 1))
    const shown = (id: string) => view.container.querySelector(`[data-call-text="${id}"]`)?.textContent
    await paint(3)
    expect(shown(callIds[0]!)!.length).toBeGreaterThan(0)
    expect(shown(callIds[0]!)!.length).toBeLessThan(initial.length)
    await act(async () => { window.dispatchEvent(new Event('pagehide')) })
    view.rerender(tree(batchA, 3))
    await act(async () => {})
    expect(view.container.querySelector(`[data-group-id="${groupKeys[1]}"]`)).toBeNull()
    expect(view.container.querySelector(`[data-group-id="${groupKeys[2]}"]`)).toBeNull()
    await act(async () => { window.dispatchEvent(new Event('pageshow')) })
    await paint()
    expect(streamRelay.recoveryEpoch('["group-session","1"]')).toBe(0)
    expect(view.container.querySelector(`[data-group-id="${groupKeys[1]}"]`)).toBeNull()
    // Group 2 already belongs to snapshot A, but its actual renderer has never
    // mounted when both this text suffix and child from B arrive.
    view.rerender(tree(batchA, 3, true))
    for (let frame = 0; frame < 1200 && shown(callIds[2]!) !== thirdText; frame++) {
      expect(shown(callIds[1]!)?.length ?? 0).toBeLessThanOrEqual(secondText.length)
      expect(view.container.querySelector(`[data-chat-call-id="${childId}"]`)).toBeNull()
      if (shown(callIds[2]!) !== undefined) expect(shown(callIds[1]!)).toBe(secondText)
      await paint()
    }
    expect(shown(callIds[2]!)).toBe(thirdText)
    await paint(1200)
    expect(shown(callIds[0]!)).toBe(batchA)
    expect(shown(callIds[1]!)).toBe(secondB)
    expect(shown(childId)).toBe(childText)
    expect(streamRelay.recoveryEpoch('["group-session","1"]')).toBeUndefined()
  })

  it('creates latest recovery groups in source order and releases every lease on unmount', async () => {
    const acquire = vi.spyOn(streamRelay, 'acquire')
    const release = vi.spyOn(streamRelay, 'release')
    try {
      const fixture = recoveryFlow('latest')
      const { paint, tree, initial, batchA, batchB, secondText, thirdText, nodeKeys, callIds, created } = fixture
      const view = render(tree(initial, 1))
      const shown = (id: string) => view.container.querySelector(`[data-call-text="${id}"]`)?.textContent
      await paint(3)
      expect(shown(callIds[0]!)!.length).toBeLessThan(initial.length)
      await act(async () => { window.dispatchEvent(new Event('pagehide')) })
      view.rerender(tree(batchA, 3))
      await act(async () => {})
      expect([...new Set(created)]).toEqual(nodeKeys.slice(0, 1))
      await act(async () => { window.dispatchEvent(new Event('pageshow')) })
      await paint(10)
      view.rerender(tree(batchB, 3))
      await paint(1200)
      expect([...new Set(created)]).toEqual(nodeKeys)
      expect(shown(callIds[0]!)).toBe(batchB)
      expect(shown(callIds[1]!)).toBe(secondText)
      expect(shown(callIds[2]!)).toBe(thirdText)
      expect(streamRelay.recoveryEpoch('["group-session","1"]')).toBeUndefined()
      const probe = { session: 'group-session', turn: '1', step: 100, node: 'probe', order: 100 }
      expect(streamRelay.isBlocked(probe, 'response')).toBe(false)
      view.unmount()
      await act(async () => {})
      const released = new Set(release.mock.calls.map(([token]) => token))
      const acquired = acquire.mock.results.filter(result => result.type === 'return').map(result => result.value as symbol)
      expect(acquired.length).toBeGreaterThan(0)
      expect(acquired.filter(token => !released.has(token))).toEqual([])
      expect(streamRelay.hasTool({ ...probe, step: 1 })).toBe(false)
      expect(streamRelay.isBlocked(probe, 'response')).toBe(false)
      expect(streamRelay.recoveryEpoch('["group-session","1"]')).toBeUndefined()
    } finally {
      acquire.mockRestore()
      release.mockRestore()
    }
  })

  it('leaves native chrome and missing-renderer fallbacks out of the reservation queue', async () => {
    const { entry, metadata, dispose } = await installedFlow()
    const kinds = ['user', 'turn-process', 'turn-tail', 'future-without-renderer']
    const predecessors = kinds.map((kind, index) => ({ ...member, key: kind, kind, anchorSeq: index + 1 }))
    const props = {
      ...flowProps(),
      entries: [
        ...predecessors.map(node => ({ kind: 'node' as const, key: node.key })),
        { kind: 'group' as const, key: groupKey },
      ],
      useChatNode: withNodes([...predecessors, { ...member, anchorSeq: 10 }]),
    }
    const view = render(createElement(entry.component as never, props))
    expect(view.queryByTestId('group-header')).toBeNull()
    await act(async () => {})
    expect(view.getByTestId('group-header')).toBeTruthy()
    expect(view.container.querySelector('main')?.dataset.tailKind).toBe('group')
    expect(entry.options).toBe(metadata)
    await act(async () => { await dispose() })
  })

  it('creates a group whose first member uses the native fallback', async () => {
    const { entry, dispose } = await installedFlow()
    const view = render(createElement(entry.component as never, {
      ...flowProps(),
      useChatNode: withNodes([{ ...member, kind: 'future-without-renderer' }]),
    }))
    expect(view.getByTestId('group-header')).toBeTruthy()
    await act(async () => { await dispose() })
  })

  it('releases the gate in an already mounted Flow when the plugin is disposed', async () => {
    const { entry, dispose } = await installedFlow()
    const prior = streamRelay.acquire({
      session: 'group-session', turn: '1', step: 1, node: 'assistant:0', order: 1,
    }, 'response')
    const view = render(createElement(entry.component as never, flowProps()))
    await act(async () => {})
    expect(view.queryByTestId('group-header')).toBeNull()
    await act(async () => { await dispose() })
    expect(entry.component).toBe(TestFlow)
    expect(view.getByTestId('group-header')).toBeTruthy()
    await act(async () => { streamRelay.release(prior) })
  })
})
