import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement, useRef, type ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatNodeViewProps, UseDisclosure, UsePresentation } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { NativeAssistantNodeView } from '../src/client/NativeAssistantNodeView.tsx'
import { relayScope, streamRelay } from '../src/client/streamRelay.ts'
import { wrapFollowNodeView } from '../src/client/TypewriterToolNodeView.tsx'
import { DEFAULT_STREAM_SETTINGS } from '../src/settings.ts'

type Owner = ChatNodeViewProps<'assistant-step'>
type OfficialProps = Owner & PropsRenderSlots<'conversation.chat.reasoning.body' | 'conversation.chat.message.images'> & {
  usePresentation: UsePresentation
  resolveFilePath: (path: string) => string
  fileMentions: () => undefined
}
// Load the actual shipped source through Vitest without importing a second
// declaration-merge world into tsc (the public /client contract remains canonical).
const { AssistantNodeView } = await vi.importActual<{ AssistantNodeView: ComponentType<OfficialProps> }>(
  '@deepseek-ai/dsh-client-ui-chat/src/client/chat/AssistantNodeView.tsx')
const { useDisclosure, bindDisclosure } = await vi.importActual<{
  useDisclosure: UseDisclosure
  bindDisclosure: (reset: ObservableSnapshot<number>) => UseDisclosure
}>('@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts')
const preferences = { ...DEFAULT_STREAM_SETTINGS, preset: 'balanced' as const, controlScroll: false, logarithmicFade: false }

function owner(status: 'running' | 'settled' | 'interrupted', text: string, reasoning = false): OfficialProps {
  return {
    sessionId: 'session-a' as OfficialProps['sessionId'],
    node: {
      id: 'assistant:1', kind: 'assistant-step', key: 'assistant:1', target: 'chat', anchorSeq: 1,
      location: { kind: 'unresolved' }, visibility: 'visible',
      data: { status, blocks: [{ kind: reasoning ? 'reasoning' : 'text', text }], turn: 1, step: 1, time: 0 },
    },
    cwd: '/', openFile: () => {}, inspectCall: undefined, forkAt: () => {},
    loadImage: Object.assign(async () => '', { peek: () => undefined }),
    useDisclosure, useGroupAction: () => useRef<HTMLDivElement>(null), useTurnData: () => undefined,
    usePresentation: selector => selector({ settledReasoningPreview: true, foldedReplies: 'all' } as Parameters<typeof selector>[0]),
    useContextMenu: () => ({ getTriggerProps: () => ({}) }),
    renderSlot: ((name: string, props: { text?: string; running?: boolean }) => name === 'conversation.chat.reasoning.body'
      ? createElement('output', { 'data-testid': 'reasoning-body', 'data-running': String(props.running) }, props.text) : null) as OfficialProps['renderSlot'],
    renderFactorySlot: (() => null) as OfficialProps['renderFactorySlot'],
    resolveFilePath: path => path, fileMentions: () => undefined,
    t: ((key: string) => key === 'message.think' ? 'Official thinking' : key) as OfficialProps['t'],
  } as OfficialProps
}

const Probe = (props: Owner) => createElement('article', null,
  props.node.data.blocks.map(block =>
    (block.kind === 'text' && props.groupPart !== 'reasoning') || (block.kind === 'reasoning' && props.groupPart !== 'response') ? block.text : '').join(''))

let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let timestamp: number
async function paint(count = 1): Promise<void> {
  for (let i = 0; i < count; i++) await act(() => {
    const batch = [...frames.values()]
    frames.clear()
    timestamp += 16
    for (const callback of batch) callback(timestamp)
  })
}
function native(props: OfficialProps, settings = preferences, Inner: ComponentType<Owner> = Probe) {
  return createElement(NativeAssistantNodeView, { Inner, owner: props, preferences: settings })
}
// Keep the official renderer's injected props and child Slot renderer on owner.
const Official = (props: Owner) => createElement(AssistantNodeView, props as OfficialProps)

afterEach(() => {
  cleanup()
  streamRelay.clearAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.useFakeTimers()
  frames = new Map()
  nextFrame = 1
  timestamp = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('performance', { now: () => timestamp })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
})

describe('native assistant wrapper', () => {
  it('paces live text and preserves injected capabilities, child slots and locale', async () => {
    const seen: Owner[] = []
    const Inner = (props: Owner) => { seen.push(props); return createElement(Probe, props) }
    const props = owner('running', 'abcdefghij')
    const view = render(native(props, preferences, Inner))
    expect(view.container.textContent).toBe('')
    await paint(3)
    expect(view.container.textContent?.length).toBeGreaterThan(0)
    expect(view.container.textContent?.length).toBeLessThan(10)
    const last = seen.at(-1) as OfficialProps
    expect(last.useGroupAction).toBe(props.useGroupAction)
    expect(last.usePresentation).toBe(props.usePresentation)
    expect(last.useContextMenu).toBe(props.useContextMenu)
    expect(last.renderSlot).toBe(props.renderSlot)
    expect(last.renderFactorySlot).toBe(props.renderFactorySlot)
    expect(last.t).toBe(props.t)
    expect(last.resolveFilePath).toBe(props.resolveFilePath)
  })

  it('starts a fresh queue for a new session/turn/node even when text extends the prior prefix', async () => {
    const props = owner('running', 'first answer')
    const view = render(native(props))
    await paint(50)
    expect(view.container.textContent).toBe('first answer')
    const next = { ...props, sessionId: 'session-b' as OfficialProps['sessionId'], node: { ...props.node,
      key: 'assistant:2', data: { ...props.node.data, turn: 2, blocks: [{ kind: 'text' as const, text: 'first answer next turn' }] } } }
    view.rerender(native(next))
    expect(view.container.textContent).toBe('')
    expect(streamRelay.isBlocked(relayScope(props.node, props.sessionId), 'tool')).toBe(false)
    await paint(3)
    expect(view.container.textContent?.length).toBeGreaterThan(0)
    expect(view.container.textContent?.length).toBeLessThan('first answer'.length)
  })

  it('does not replay historical text or take a relay lease', () => {
    const props = owner('settled', 'historical answer')
    const view = render(createElement('section', { 'data-chat-flow-key': 'historical' }, native(props)))
    expect(view.getByText('historical answer')).toBeTruthy()
    expect(view.container.querySelector('[data-chat-flow-key]')?.getAttribute('data-smooth-stream-settled')).toBe('true')
    expect(streamRelay.isBlocked(relayScope(props.node, props.sessionId), 'tool')).toBe(false)
  })

  it('uses real official renderer/hooks to auto-open and close only after completion drains', async () => {
    const props = owner('running', 'reasoning '.repeat(20), true)
    const view = render(native(props, preferences, Official))
    await paint(3)
    expect(view.getByText('Official thinking')).toBeTruthy()
    expect(view.getByTestId('reasoning-body').textContent?.length).toBeGreaterThan(0)
    expect(view.container.querySelector('[data-variant="think"]')?.hasAttribute('data-expanded')).toBe(true)
    const settled = { ...props, node: { ...props.node, data: { ...props.node.data, status: 'settled' as const } } }
    view.rerender(native(settled, preferences, Official))
    expect(view.queryByTestId('reasoning-body')).not.toBeNull()
    expect(streamRelay.isBlocked(relayScope(props.node, props.sessionId), 'tool')).toBe(true)
    await paint(80)
    expect(view.queryByTestId('reasoning-body')).toBeNull()
    expect(streamRelay.isBlocked(relayScope(props.node, props.sessionId), 'tool')).toBe(false)
  })

  it('respects manual collapse and the official enclosing-Turn disclosure reset', async () => {
    const reset = createSnapshotStore(0)
    const props = { ...owner('running', 'reasoning '.repeat(10), true), useDisclosure: bindDisclosure(reset) }
    const view = render(native(props, preferences, Official))
    await paint(3)
    fireEvent.click(view.getByText('Official thinking'))
    expect(view.queryByTestId('reasoning-body')).toBeNull()
    await paint(3)
    expect(view.queryByTestId('reasoning-body')).toBeNull()
    fireEvent.click(view.getByText('Official thinking'))
    expect(view.queryByTestId('reasoning-body')).not.toBeNull()
    act(() => { reset.set(1) })
    expect(view.queryByTestId('reasoning-body')).toBeNull()
    await paint(3)
    expect(view.queryByTestId('reasoning-body')).toBeNull()
  })

  it('preserves an explicit manual open after the stream settles', async () => {
    const props = owner('running', 'thinking text', true)
    const view = render(native(props, preferences, Official))
    await paint(3)
    fireEvent.click(view.getByText('Official thinking'))
    fireEvent.click(view.getByText('Official thinking'))
    view.rerender(native({ ...props, node: { ...props.node, data: { ...props.node.data, status: 'settled' } } }, preferences, Official))
    await paint(80)
    expect(view.queryByTestId('reasoning-body')).not.toBeNull()
  })

  it('closes drained reasoning when a later response becomes the tail in the same official renderer', async () => {
    const props = owner('running', 'reasoning '.repeat(8), true)
    const view = render(native(props, preferences, Official))
    await paint(3)
    expect(view.queryByTestId('reasoning-body')).not.toBeNull()
    const response = { ...props, node: { ...props.node, data: { ...props.node.data,
      blocks: [...props.node.data.blocks, { kind: 'text' as const, text: 'response '.repeat(100) }] } } }
    view.rerender(native(response, preferences, Official))
    expect(view.queryByTestId('reasoning-body')).not.toBeNull()
    await paint(100)
    expect(view.queryByTestId('reasoning-body')).toBeNull()
    expect(streamRelay.isBlocked(relayScope(props.node, props.sessionId), 'tool')).toBe(true)
  })

  it('keeps auto-expand disabled for a live official reasoning renderer', async () => {
    const props = owner('running', 'thinking text', true)
    const view = render(native(props, { ...preferences, thinkAutoExpand: false }, Official))
    await paint(12)
    expect(view.queryByTestId('reasoning-body')).toBeNull()
  })

  it('keeps reasoning/response groupPart instances sequential and isolates sessions', async () => {
    const props = owner('running', 'thinking '.repeat(15), true)
    const grouped = { ...props, node: { ...props.node, data: { ...props.node.data,
      blocks: [...props.node.data.blocks, { kind: 'text' as const, text: 'response text' }] } } }
    const reasoning = { ...grouped, groupPart: 'reasoning' }
    const response = { ...grouped, groupPart: 'response' }
    const other = { ...response, sessionId: 'session-b' as OfficialProps['sessionId'] }
    const view = render(createElement('div', null,
      createElement('section', { 'data-testid': 'reasoning' }, native(reasoning)),
      createElement('section', { 'data-testid': 'response' }, native(response)),
      createElement('section', { 'data-testid': 'other' }, native(other))))
    await paint(8)
    expect(view.getByTestId('reasoning').textContent?.length).toBeGreaterThan(0)
    expect(view.getByTestId('response').textContent).toBe('')
    expect(view.getByTestId('other').textContent?.length).toBeGreaterThan(0)
    await paint(140)
    expect(view.getByTestId('response').textContent).toBe('response text')
  })

  it.each([true, false])('keepStreamOnToolCall=%s controls the actual tool handoff', async keep => {
    const props = owner('running', 'lead-in '.repeat(20))
    const settings = { ...preferences, keepStreamOnToolCall: keep }
    const Tool = wrapFollowNodeView(() => createElement('aside', null, 'tool done'), () => false)
    const toolNode = { key: 'tool:1', anchorSeq: 2, location: { kind: 'unresolved' }, data: { turn: 1, step: 1, root: { kind: 'tool-result' } } }
    const view = render(createElement('div', null,
      createElement('section', { 'data-chat-flow-key': 'assistant' }, native(props, settings, Official)),
      createElement('section', { 'data-chat-flow-key': 'tool' }, createElement(Tool, { node: toolNode, sessionId: props.sessionId }))))
    await act(async () => {})
    const aside = view.getByText('tool done')
    const shell = aside.closest('div[style]') as HTMLElement
    if (keep) {
      expect(shell.style.opacity).toBe('0')
      await act(() => vi.advanceTimersByTimeAsync(7000))
      expect(shell.style.opacity).toBe('0')
      expect(view.container.querySelector('[data-chat-flow-key="assistant"]')?.textContent).not.toBe('lead-in '.repeat(20))
      await paint(100)
    }
    expect(shell.style.opacity).not.toBe('0')
    expect(view.container.querySelector('[data-chat-flow-key="assistant"]')?.textContent?.trim()).toBe('lead-in '.repeat(20).trim())
  })

  it('does not let a preceding native row from another session block a tool overlay', async () => {
    const props = owner('running', 'queued '.repeat(20))
    const Tool = wrapFollowNodeView(() => createElement('aside', null, 'other session tool'), () => false)
    const view = render(createElement('div', null,
      createElement('section', { 'data-chat-flow-key': 'assistant-a' }, native(props)),
      createElement('section', { 'data-chat-flow-key': 'tool-b' }, createElement(Tool, {
        sessionId: 'session-b', node: { key: 'tool:1', anchorSeq: 2, data: { turn: 1, step: 1, root: { kind: 'tool-result' } } },
      }))))
    await act(async () => {})
    expect((view.getByText('other session tool').closest('div[style]') as HTMLElement).style.opacity).not.toBe('0')
    expect(streamRelay.isBlocked(relayScope(props.node, props.sessionId), 'tool')).toBe(true)
  })

  it('releases a waiting quick tool when its preceding native row unmounts', async () => {
    const props = owner('running', 'queued '.repeat(20))
    const Tool = wrapFollowNodeView(() => createElement('aside', null, 'finished tool'), () => false)
    const tool = createElement(Tool, { sessionId: props.sessionId, node: {
      key: 'tool:1', anchorSeq: 2, data: { turn: 1, step: 1, root: { kind: 'tool-result' } },
    } })
    const tree = (assistant: boolean) => createElement('div', null,
      createElement('section', { key: 'a', 'data-chat-flow-key': 'assistant' }, assistant ? native(props) : null),
      createElement('section', { key: 'b', 'data-chat-flow-key': 'tool' }, tool))
    const view = render(tree(true))
    expect((view.getByText('finished tool').closest('div[style]') as HTMLElement).style.opacity).toBe('0')
    view.rerender(tree(false))
    await act(async () => {})
    expect((view.getByText('finished tool').closest('div[style]') as HTMLElement).style.opacity).not.toBe('0')
  })

  it('updates official reasoning disclosure when auto-expand changes without a new text chunk', async () => {
    const props = owner('running', 'thinking text', true)
    const view = render(native(props, preferences, Official))
    await paint(40)
    expect(view.queryByTestId('reasoning-body')).not.toBeNull()
    view.rerender(native(props, { ...preferences, thinkAutoExpand: false }, Official))
    expect(view.queryByTestId('reasoning-body')).toBeNull()
  })

  it('releases all work on interruption and unmount without clearing another instance lease', async () => {
    const props = owner('running', 'queued '.repeat(20))
    const a = render(native(props))
    const b = render(native(props))
    const scope = relayScope(props.node, props.sessionId)
    expect(streamRelay.isBlocked(scope, 'tool')).toBe(true)
    a.unmount()
    expect(streamRelay.isBlocked(scope, 'tool')).toBe(true)
    b.rerender(native({ ...props, node: { ...props.node, data: { ...props.node.data, status: 'interrupted' } } }))
    expect(streamRelay.isBlocked(scope, 'tool')).toBe(false)
    b.unmount()
    await paint(2)
    expect(streamRelay.isBlocked(scope, 'tool')).toBe(false)
  })
})
