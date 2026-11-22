import { assistantProgress } from '../src/client/presentationProgress.ts'
import { clearToolPresentationLedger } from '../src/client/TypewriterToolNodeView.tsx'
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
import { isBackgroundRecoveryScope } from '../src/client/backgroundRecovery.ts'

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
  for (let i = 0; i < count; i++) await act(async () => {
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
  assistantProgress.clear()
  clearToolPresentationLedger()
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
  it('keeps a committed prefix across parent changes caused by interleaved input', async () => {
    const props = owner('running', 'x'.repeat(500))
    const tree = (group: string) => createElement('main', null,
      createElement('section', { key: group }, native(props)))
    const view = render(tree('before-steering'))
    await paint(10)
    const before = view.container.textContent!
    expect(before.length).toBeGreaterThan(0)
    view.rerender(tree('after-steering'))
    expect(view.container.textContent).toBe(before)
    await paint(3)
    expect(view.container.textContent!.startsWith(before)).toBe(true)
  })

  it('does not subscribe or reserve a relay for static history', () => {
    const blocked = vi.spyOn(streamRelay, 'subscribeBlocked')
    const tool = vi.spyOn(streamRelay, 'subscribeTool')
    const acquire = vi.spyOn(streamRelay, 'acquire')
    const view = render(native(owner('settled', 'already displayed')))
    expect(view.container.textContent).toBe('already displayed')
    expect(blocked).not.toHaveBeenCalled()
    expect(tool).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    blocked.mockRestore(); tool.mockRestore(); acquire.mockRestore()
  })

  it('releases a drained response and never replays it when a predecessor activates', async () => {
    const props = owner('running', 'finished')
    const view = render(native(props))
    await paint(50)
    expect(view.container.textContent).toBe('finished')
    expect(streamRelay.isBlocked(relayScope(props.node, props.sessionId), 'tool')).toBe(false)
    const before = { ...relayScope(props.node, props.sessionId), node: 'earlier', order: 0 }
    let token: symbol
    await act(() => { token = streamRelay.acquire(before, 'response') })
    expect(view.container.textContent).toBe('finished')
    await act(() => { streamRelay.release(token!) })
    view.unmount()
    const again = render(native(props))
    expect(again.container.textContent).toBe('finished')
  })

  it('applies latest on returning to an existing live reply then paces new text', async () => {
    const settings = { ...preferences, backgroundRecovery: 'latest' as const }
    const first = render(native(owner('running', 'first'), settings))
    await paint(40)
    first.unmount()
    const props = owner('running', 'first' + 'x'.repeat(200))
    const view = render(native(props, settings))
    expect(view.container.textContent).toBe('first')
    await paint(3)
    expect(view.container.textContent).toBe('first' + 'x'.repeat(200))
    const updated = owner('running', 'first' + 'x'.repeat(300))
    view.rerender(native(updated, settings))
    await paint(3)
    expect(view.container.textContent!.length).toBeGreaterThan(205)
    expect(view.container.textContent!.length).toBeLessThan(305)
  })

  it('does not wake static history on foreground transitions or fill the progress cache', async () => {
    const props = owner('running', 'kept live prefix')
    const first = render(native(props))
    await paint(50)
    first.unmount()
    let renders = 0
    const StaticProbe = (props: Owner) => { renders++; return createElement(Probe, props) }
    const history = Array.from({ length: 520 }, (_, index) => {
      const item = owner('settled', `history ${index}`)
      item.node = { ...item.node, key: `history:${index}` }
      return createElement(NativeAssistantNodeView, { key: index, Inner: StaticProbe, owner: item,
        preferences: { ...preferences, controlScroll: true } })
    })
    const view = render(createElement('main', null, ...history))
    const before = renders
    await act(() => { window.dispatchEvent(new Event('dsha:background')) })
    await act(() => { window.dispatchEvent(new Event('dsha:foreground')) })
    expect(renders).toBe(before)
    view.unmount()
    const again = render(native(props))
    expect(again.container.textContent).toBe('kept live prefix')
  })

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

  it.each(['replay', 'catch-up', 'latest'] as const)('orders a first settled reply behind recovering reasoning in %s mode', async mode => {
    const initial = { ...owner('running', 'r'.repeat(200), true), groupPart: 'reasoning' }
    const settings = { ...preferences, backgroundRecovery: mode }
    const tree = (settled: boolean) => {
      const snapshot: OfficialProps = settled ? { ...initial, node: { ...initial.node, data: { ...initial.node.data,
        status: 'settled', blocks: [{ kind: 'reasoning', text: 'r'.repeat(400) }, { kind: 'text', text: 'final answer' }] } } } : initial
      return createElement('main', null,
        createElement('section', { key: 'reasoning', 'data-testid': 'reasoning-seat' }, native(snapshot, settings)),
        settled ? createElement('section', { key: 'response', 'data-testid': 'response-seat' }, native({ ...snapshot, groupPart: 'response' }, settings)) : null)
    }
    const view = render(tree(false))
    await paint(3)
    const before = view.getByTestId('reasoning-seat').textContent!.length
    await act(() => { window.dispatchEvent(new Event('pagehide')) })
    await act(() => { window.dispatchEvent(new Event('pageshow')) })
    // A slow reconnect must not lose the policy after the old one-second window.
    timestamp += 3000
    view.rerender(tree(true))
    expect(view.getByTestId('reasoning-seat').textContent).toHaveLength(before)
    expect(view.getByTestId('response-seat').querySelector('[data-smooth-stream-phase]')?.getAttribute('data-smooth-stream-phase')).toBe('waiting')
    expect(view.getByTestId('response-seat').textContent).toBe('')
    for (let index = 0; index < 500; index++) {
      await paint()
      if (view.getByTestId('response-seat').textContent !== '') {
        expect(view.getByTestId('reasoning-seat').textContent).toBe('r'.repeat(400))
      }
    }
    expect(view.getByTestId('response-seat').textContent).toBe('final answer')
  })

  it('shows a first completed tool immediately during recovery', async () => {
    const props = { ...owner('running', 'r'.repeat(400), true), groupPart: 'reasoning' }
    const Tool = wrapFollowNodeView(() => createElement('aside', null, 'tool result '.repeat(30)), () => false)
    const tree = (result: boolean) => createElement('main', null,
      native(result ? { ...props, node: { ...props.node, data: { ...props.node.data, status: 'settled' } } } : props),
      result ? createElement('section', { 'data-testid': 'closed-tool' }, createElement(Tool, {
        sessionId: props.sessionId, node: { key: 'tool:1', kind: 'tool-call', anchorSeq: 2,
          data: { turn: 1, step: 1, root: { kind: 'tool-result' } },
          location: { kind: 'step', turn: { turn: 1, status: 'closed' }, step: { step: 1, status: 'closed' } } },
      })) : null)
    const view = render(tree(false))
    await paint(3)
    await act(() => { window.dispatchEvent(new Event('dsha:background')) })
    await act(() => { window.dispatchEvent(new Event('dsha:foreground')) })
    timestamp += 3000
    view.rerender(tree(true))
    expect(view.getByTestId('closed-tool').textContent).toBe('tool result '.repeat(30))
    expect(view.getByTestId('closed-tool').querySelector('[data-smooth-stream-phase]')?.getAttribute('data-smooth-stream-phase')).toBe('settled')
    await paint(400)
    expect(view.getByTestId('closed-tool').textContent).toBe('tool result '.repeat(30))
  })

  it('keeps first-settled history static while its live predecessor drains', async () => {
    const first = owner('running', 'a'.repeat(100))
    const item = (step: number, text: string) => ({ ...owner('settled', text), node: { ...first.node,
      key: `assistant:${step}`, anchorSeq: step, data: { ...first.node.data, status: 'settled' as const,
        step, blocks: [{ kind: 'text' as const, text }] } } })
    const second = item(2, 'b'.repeat(100))
    const third = item(3, 'c'.repeat(100))
    const tree = (done: boolean) => createElement('main', null,
      createElement('section', { 'data-testid': 'a' }, native(done ? { ...first, node: { ...first.node,
        data: { ...first.node.data, status: 'settled' } } } : first)),
      createElement('section', { 'data-testid': 'b' }, native(second)),
      createElement('section', { 'data-testid': 'c' }, native(third)))
    const view = render(tree(false))
    await paint(3)
    view.rerender(tree(true))
    for (let index = 0; index < 200; index++) {
      await paint()
      expect(view.getByTestId('b').textContent).toBe('b'.repeat(100))
      expect(view.getByTestId('c').textContent).toBe('c'.repeat(100))
    }
    expect(view.getByTestId('c').textContent).toBe('c'.repeat(100))
  })

  it('retires a recovery scope when a drained live seat settles without new text', async () => {
    const props = owner('running', 'short')
    const view = render(native(props))
    await paint(30)
    await act(() => { window.dispatchEvent(new Event('dsha:background')) })
    await act(() => { window.dispatchEvent(new Event('dsha:foreground')) })
    expect(isBackgroundRecoveryScope(JSON.stringify([props.sessionId, '1']))).toBe(true)
    view.rerender(native({ ...props, node: { ...props.node, data: { ...props.node.data, status: 'settled' } } }))
    expect(isBackgroundRecoveryScope(JSON.stringify([props.sessionId, '1']))).toBe(false)
  })

  it('does not replay an earlier settled step remounted during recovery of a later step', async () => {
    const later = owner('running', 'x'.repeat(200))
    later.node = { ...later.node, key: 'assistant:2', anchorSeq: 5, data: { ...later.node.data, step: 2 } }
    const earlier = owner('settled', 'historical text')
    const tree = (history: boolean) => createElement('main', null,
      history ? createElement('section', { key: 'old', 'data-testid': 'old' }, native(earlier)) : null,
      createElement('section', { key: 'new' }, native(later)))
    const view = render(tree(false))
    await paint(3)
    await act(() => { window.dispatchEvent(new Event('dsha:background')) })
    await act(() => { window.dispatchEvent(new Event('dsha:foreground')) })
    view.rerender(tree(true))
    expect(view.getByTestId('old').textContent).toBe('historical text')
    expect(view.getByTestId('old').querySelector('[data-smooth-stream-phase]')?.getAttribute('data-smooth-stream-phase')).toBe('settled')
  })

  it('keeps first completed tools out of the live queue', async () => {
    const props = owner('running', 'r'.repeat(100))
    const Tool = wrapFollowNodeView(p => createElement('aside', { 'data-testid': p.id }, String(p.id).repeat(100)), () => false)
    const tools = ['b', 'c'].map((id, index) => createElement(Tool, {
      key: id, id, sessionId: props.sessionId, node: { key: id, kind: 'tool-call', anchorSeq: index + 2,
        data: { turn: 1, step: 1, root: { kind: 'tool-result' } },
        location: { kind: 'step', turn: { turn: 1, status: 'closed' }, step: { step: 1, status: 'closed' } } },
    }))
    const tree = (done: boolean) => createElement('main', null,
      createElement('section', { 'data-testid': 'r' }, native(done ? { ...props, node: { ...props.node, data: { ...props.node.data,
        status: 'settled', blocks: [...props.node.data.blocks, { kind: 'tool-call', callId: 'b', name: 'test', argsRaw: '{}' }] } } } : props)), ...tools)
    const view = render(tree(false))
    await paint(3)
    view.rerender(tree(true))
    for (let index = 0; index < 300; index++) {
      await paint()
      expect(view.getByTestId('b').textContent).toBe('b'.repeat(100))
      expect(view.getByTestId('c').textContent).toBe('c'.repeat(100))
    }
    expect(view.getByTestId('c').textContent).toBe('c'.repeat(100))
  })

  it('never activates a static settled reply from a live predecessor', async () => {
    const first = owner('running', 'r'.repeat(200), true)
    const settled = { ...owner('settled', 'final answer'), groupPart: 'response' }
    const view = render(createElement('main', null,
      native({ ...first, groupPart: 'reasoning' }),
      createElement('section', { 'data-testid': 'settled' }, native(settled))))
    expect(view.getByTestId('settled').querySelector('[data-smooth-stream-phase]')?.getAttribute('data-smooth-stream-phase')).toBe('settled')
    await paint(150)
    // Existing settled text remains visible even when live reasoning changes.
    expect(view.getByTestId('settled').querySelector('[data-smooth-stream-phase]')?.getAttribute('data-smooth-stream-phase')).toBe('settled')
  })

  it('synchronizes large collapsed recovery reasoning instead of waiting on hidden character debt', async () => {
    const props = owner('running', 'reasoning '.repeat(160), true)
    const view = render(native(props, preferences, Official))
    await paint(3)
    expect(view.queryByTestId('reasoning-body')).not.toBeNull()
    await act(() => { window.dispatchEvent(new Event('dsha:background')) })
    view.rerender(native({ ...props, node: { ...props.node, data: { ...props.node.data,
      blocks: [{ kind: 'reasoning', text: 'reasoning '.repeat(180) }] } } }, preferences, Official))
    await act(() => { window.dispatchEvent(new Event('dsha:foreground')) })
    expect(view.queryByTestId('reasoning-body')).toBeNull()
    await paint(4)
    // Hidden source is synchronized in a frame, so the old 700-frame drain
    // must no longer gate automatic expansion or a following visible reply.
    expect(view.getByTestId('reasoning-body').textContent).toBe('reasoning '.repeat(180))
  })

  it('leaves automatic reasoning expanded for a small recovery backlog', async () => {
    const props = owner('running', 'reasoning '.repeat(20), true)
    const view = render(native(props, preferences, Official))
    await paint(3)
    await act(() => { window.dispatchEvent(new Event('dsha:background')) })
    await act(() => { window.dispatchEvent(new Event('dsha:foreground')) })
    await paint(4)
    expect(view.queryByTestId('reasoning-body')).not.toBeNull()
  })

  it('does not collapse a manually opened reasoning panel during large recovery', async () => {
    const props = owner('running', 'reasoning '.repeat(180), true)
    const view = render(native(props, preferences, Official))
    await paint(3)
    fireEvent.click(view.getByText('Official thinking'))
    fireEvent.click(view.getByText('Official thinking'))
    await act(() => { window.dispatchEvent(new Event('dsha:background')) })
    await act(() => { window.dispatchEvent(new Event('dsha:foreground')) })
    expect(view.queryByTestId('reasoning-body')).not.toBeNull()
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
    const toolNode = { key: 'tool:1', kind: 'tool-call', anchorSeq: 2, location: { kind: 'unresolved' }, data: { turn: 1, step: 1, root: {} } }
    const view = render(createElement('div', null,
      createElement('section', { 'data-chat-flow-key': 'assistant' }, native(props, settings, Official)),
      createElement('section', { 'data-chat-flow-key': 'tool' }, createElement(Tool, { node: toolNode, sessionId: props.sessionId }))))
    await act(async () => {})
    const aside = view.container.querySelector('aside')!
    const shell = aside.closest('[data-smooth-stream-phase]') as HTMLElement
    if (keep) {
      expect(shell.style.opacity).toBe('0')
      await act(() => vi.advanceTimersByTimeAsync(7000))
      expect(shell.style.opacity).toBe('0')
      expect(view.container.querySelector('[data-chat-flow-key="assistant"]')?.textContent).not.toBe('lead-in '.repeat(20))
      await paint(100)
    }
    expect(shell.style.opacity).not.toBe('0')
    await paint(30)
    expect(aside.textContent).toBe('tool done')
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

  it('releases a waiting live tool when its preceding native row unmounts', async () => {
    const props = owner('running', 'queued '.repeat(20))
    const Tool = wrapFollowNodeView(() => createElement('aside', null, 'finished tool'), () => false)
    const tool = createElement(Tool, { sessionId: props.sessionId, node: {
      key: 'tool:1', kind: 'tool-call', anchorSeq: 2, data: { turn: 1, step: 1, root: {} },
    } })
    const tree = (assistant: boolean) => createElement('div', null,
      createElement('section', { key: 'a', 'data-chat-flow-key': 'assistant' }, assistant ? native(props) : null),
      createElement('section', { key: 'b', 'data-chat-flow-key': 'tool' }, tool))
    const view = render(tree(true))
    const shell = view.container.querySelector('[data-chat-flow-key="tool"] [data-smooth-stream-phase]') as HTMLElement
    expect(shell.style.opacity).toBe('0')
    expect(shell.textContent).toBe('')
    view.rerender(tree(false))
    await act(async () => {})
    expect(shell.style.opacity).not.toBe('0')
    await paint(30)
    expect(shell.textContent).toBe('finished tool')
  })

  it('updates official reasoning disclosure when auto-expand changes without a new text chunk', async () => {
    const props = owner('running', 'thinking text', true)
    const view = render(native(props, preferences, Official))
    await paint(40)
    expect(view.queryByTestId('reasoning-body')).not.toBeNull()
    view.rerender(native(props, { ...preferences, thinkAutoExpand: false }, Official))
    expect(view.queryByTestId('reasoning-body')).toBeNull()
  })

  it('skips a large collapsed reasoning queue but retains the official animated visible header', async () => {
    const props = owner('running', 'hidden reasoning '.repeat(2000), true)
    const settings = { ...preferences, thinkAutoExpand: false }
    const scope = relayScope(props.node, props.sessionId)
    const view = render(native(props, settings, Official))
    await paint(4)
    expect(view.queryByTestId('reasoning-body')).toBeNull()
    expect(view.getByText('Official thinking').closest('[data-disclosure-header]')).not.toBeNull()
    expect(view.container.querySelector('[data-variant="think"]')?.getAttribute('data-state')).toBe('running')
    expect(streamRelay.isBlocked(scope, 'response')).toBe(false)
    fireEvent.click(view.getByText('Official thinking'))
    expect(view.getByTestId('reasoning-body').textContent).toBe('hidden reasoning '.repeat(2000))
    await paint(2)
    expect(view.getByTestId('reasoning-body').textContent).toBe('hidden reasoning '.repeat(2000))
    const appended = 'hidden reasoning '.repeat(2000) + 'new visible reasoning '.repeat(100)
    view.rerender(native({ ...props, node: { ...props.node, data: { ...props.node.data,
      blocks: [{ kind: 'reasoning', text: appended }] } } }, settings, Official))
    await paint(4)
    expect(view.getByTestId('reasoning-body').textContent!.length).toBeGreaterThan('hidden reasoning '.repeat(2000).length)
    expect(view.getByTestId('reasoning-body').textContent!.length).toBeLessThan(appended.length)
  })

  it('releases pending expanded reasoning on manual collapse and opens the existing full snapshot without replay', async () => {
    const text = 'visible pending reasoning '.repeat(1000)
    const props = owner('running', text, true)
    const scope = relayScope(props.node, props.sessionId)
    const view = render(native(props, preferences, Official))
    await paint(4)
    expect(view.getByTestId('reasoning-body').textContent!.length).toBeLessThan(text.length)
    expect(streamRelay.isBlocked(scope, 'tool')).toBe(true)
    fireEvent.click(view.getByText('Official thinking'))
    await paint(4)
    expect(view.queryByTestId('reasoning-body')).toBeNull()
    expect(streamRelay.isBlocked(scope, 'tool')).toBe(false)
    fireEvent.click(view.getByText('Official thinking'))
    expect(view.getByTestId('reasoning-body').textContent).toBe(text)
  })

  it('does not let one expanded disclosure requeue another collapsed reasoning block', async () => {
    const first = 'first reasoning'
    const second = 'second hidden reasoning '.repeat(1000)
    const base = owner('running', first, true)
    const props = { ...base, node: { ...base.node, data: { ...base.node.data,
      blocks: [{ kind: 'reasoning' as const, text: first }, { kind: 'reasoning' as const, text: second }] } } }
    const settings = { ...preferences, thinkAutoExpand: false }
    const view = render(native(props, settings, Official))
    await paint(4)
    fireEvent.click(view.getAllByText('Official thinking')[0]!)
    expect(view.getByTestId('reasoning-body').textContent).toBe(first)
    view.rerender(native({ ...props, node: { ...props.node, data: { ...props.node.data,
      blocks: [{ kind: 'reasoning', text: first }, { kind: 'reasoning', text: second + 'new hidden tail '.repeat(1000) }] } } }, settings, Official))
    await paint(4)
    expect(view.getAllByTestId('reasoning-body')).toHaveLength(1)
    expect(view.getByTestId('reasoning-body').textContent).toBe(first)
    expect(streamRelay.isBlocked(relayScope(props.node, props.sessionId), 'response')).toBe(false)
  })

  it('synchronizes signature-only reasoning that the official renderer never displays', async () => {
    const props = owner('running', '<signature>' + '隐🙂'.repeat(10000) + '</signature>', true)
    const view = render(native(props, preferences, Official))
    await paint(4)
    expect(view.container.querySelector('[data-variant="think"]')).toBeNull()
    expect(view.queryByTestId('reasoning-body')).toBeNull()
    expect(streamRelay.isBlocked(relayScope(props.node, props.sessionId), 'tool')).toBe(false)
  })

  it('maps visible disclosures after a filtered signature block and skips only the signature prefix', async () => {
    const signature = '<signature>' + 'private metadata '.repeat(2000) + '</signature>\r\n'
    const visible = 'visible reasoning'
    const base = owner('running', signature, true)
    const props = { ...base, node: { ...base.node, data: { ...base.node.data,
      blocks: [{ kind: 'reasoning' as const, text: signature }, { kind: 'reasoning' as const, text: visible }] } } }
    const settings = { ...preferences, thinkAutoExpand: false }
    const view = render(native(props, settings, Official))
    await paint(4)
    expect(view.getAllByText('Official thinking')).toHaveLength(1)
    fireEvent.click(view.getByText('Official thinking'))
    expect(view.getByTestId('reasoning-body').textContent).toBe(visible)
    const appended = visible + 'new visible tail '.repeat(100)
    view.rerender(native({ ...props, node: { ...props.node, data: { ...props.node.data,
      blocks: [{ kind: 'reasoning', text: signature }, { kind: 'reasoning', text: appended }] } } }, settings, Official))
    await paint(4)
    expect(view.getByTestId('reasoning-body').textContent!.length).toBeGreaterThan(visible.length)
    expect(view.getByTestId('reasoning-body').textContent!.length).toBeLessThan(appended.length)
    expect(streamRelay.isBlocked(relayScope(props.node, props.sessionId), 'tool')).toBe(true)
  })

  it('skips a signature prefix within an expanded reasoning block without replaying hidden metadata', async () => {
    const visible = 'actual visible reasoning'
    const props = owner('running', '<signature>' + 'private metadata '.repeat(2000) + '</signature>\n' + visible, true)
    const view = render(native(props, preferences, Official))
    await paint(20)
    expect(view.getByTestId('reasoning-body').textContent).toBe(visible)
    expect(streamRelay.isBlocked(relayScope(props.node, props.sessionId), 'tool')).toBe(false)
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
