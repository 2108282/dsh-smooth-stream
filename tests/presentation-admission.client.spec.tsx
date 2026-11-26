import { act, cleanup, render } from '@testing-library/react'
import { createElement, useEffect, useRef, type ComponentType } from 'react'
import type { AssistantBlock, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeAssistantNodeView, assistantTextSegments, projectAssistantPresentation } from '../src/client/NativeAssistantNodeView.tsx'
import { assistantProgress } from '../src/client/presentationProgress.ts'
import { relayScope, streamRelay } from '../src/client/streamRelay.ts'
import { usePresentationAdmission } from '../src/client/usePresentationAdmission.ts'
import { DEFAULT_STREAM_SETTINGS } from '../src/settings.ts'

type Owner = ChatNodeViewProps<'assistant-step'>
const preferences = { ...DEFAULT_STREAM_SETTINGS, preset: 'balanced' as const, controlScroll: false, logarithmicFade: false }
let frames: Map<number, FrameRequestCallback>
let timestamp: number
let nextFrame: number

function owner(key: string, order: number, blocks: readonly AssistantBlock[], part: 'reasoning' | 'response' = 'response'): Owner {
  return {
    sessionId: 'presentation-session', groupPart: part,
    node: { id: key, key, kind: 'assistant-step', target: 'chat', anchorSeq: order,
      visibility: 'visible', location: { kind: 'unresolved' },
      data: { status: 'running', turn: 1, step: 1, time: 0, blocks } },
    useDisclosure: () => ({ expanded: false, toggle: () => {} }),
  } as unknown as Owner
}
function native(props: Owner, Inner: ComponentType<Owner>, mode: 'replay' | 'catch-up' | 'latest' = 'catch-up') {
  return createElement(NativeAssistantNodeView, { owner: props, Inner, preferences: { ...preferences, backgroundRecovery: mode } })
}
async function paint(count = 1): Promise<void> {
  for (let index = 0; index < count; index++) await act(async () => {
    const callbacks = [...frames.values()]
    frames.clear()
    timestamp += 16
    for (const callback of callbacks) callback(timestamp)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  timestamp = 0
  nextFrame = 1
  frames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('performance', { now: () => timestamp })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
})
afterEach(() => {
  cleanup()
  assistantProgress.clear()
  streamRelay.clearAll()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('presentation creation follows playback', () => {
  it.each([undefined, 0])('does not create waiting SVG/effects and retains admitted DOM across epoch %s pauses', async recoveryEpoch => {
    const props = owner('later', 10, [{ kind: 'text', text: 'reply '.repeat(30) }])
    const renders = vi.fn()
    const mounts = vi.fn()
    const unmounts = vi.fn()
    const Inner = (value: Owner) => {
      renders()
      useEffect(() => { mounts(); return () => { unmounts() } }, [])
      return createElement('article', null, createElement('svg', { 'data-testid': 'icon' }), value.node.data.blocks.map(block => 'text' in block ? block.text : '').join(''))
    }
    const earlier = { ...relayScope(props.node, props.sessionId), node: 'earlier', order: 1 }
    const token = streamRelay.acquire(earlier, 'tool')
    const view = render(native(props, Inner))
    await paint(5)
    expect(renders).not.toHaveBeenCalled()
    expect(mounts).not.toHaveBeenCalled()
    expect(view.container.querySelector('article')).toBeNull()
    expect(view.container.querySelector('svg')).toBeNull()
    await act(async () => { streamRelay.release(token) })
    await paint(4)
    expect(mounts).toHaveBeenCalledTimes(1)
    const article = view.container.querySelector('article')!
    const icon = view.getByTestId('icon')
    expect(article.textContent!.length).toBeGreaterThan(0)
    const before = article.textContent!
    let next: symbol
    await act(async () => { next = streamRelay.acquire({ ...earlier, recoveryEpoch }, 'tool') })
    await paint(3)
    expect(view.container.querySelector('article')).toBe(article)
    expect(view.getByTestId('icon')).toBe(icon)
    const shell = article.closest<HTMLElement>('[data-smooth-stream-phase]')!
    expect(shell.dataset.smoothStreamPhase).toBe('waiting')
    expect(shell.style.opacity).not.toBe('0')
    expect(shell.style.height).not.toBe('0px')
    expect(article.textContent!.startsWith(before)).toBe(true)
    expect(mounts).toHaveBeenCalledTimes(1)
    expect(unmounts).not.toHaveBeenCalled()
    await act(async () => { streamRelay.release(next!) })
  })

  it('falls back to full renderer creation when an unadmitted owner becomes non-animated', async () => {
    const scope = { session: 'presentation-session', turn: '1', step: 2, node: 'later', order: 2 }
    const blocker = streamRelay.acquire({ ...scope, step: 1, node: 'first', order: 1 }, 'tool')
    function Owner({ enabled }: { enabled: boolean }) {
      const root = useRef<HTMLDivElement>(null)
      const admitted = usePresentationAdmission(scope, 'response', enabled, true, root)
      return createElement('div', { ref: root }, admitted ? createElement('article', null, 'official') : null)
    }
    const view = render(createElement(Owner, { enabled: true }))
    await act(async () => {})
    expect(view.container.querySelector('article')).toBeNull()
    view.rerender(createElement(Owner, { enabled: false }))
    expect(view.container.querySelector('article')?.textContent).toBe('official')
    await act(async () => { streamRelay.release(blocker) })
  })

  it('registers equal-anchor siblings before admitting the first renderer in Host flow order', async () => {
    const mounted: string[] = []
    const first = owner('first-response', 4, [{ kind: 'text', text: 'a'.repeat(80) }])
    const second = owner('second-reasoning', 4, [{ kind: 'reasoning', text: 'b'.repeat(30) }], 'reasoning')
    const Inner = (props: Owner) => {
      useEffect(() => { mounted.push(props.node.key) }, [])
      return createElement('article', { 'data-seat': props.node.key }, createElement('svg'), props.node.data.blocks.map(block => 'text' in block ? block.text : '').join(''))
    }
    const view = render(createElement('main', null,
      createElement('section', { key: 'first' }, native(first, Inner)),
      createElement('section', { key: 'second' }, native(second, Inner))))
    expect(view.container.querySelector('article')).toBeNull()
    await paint(3)
    expect(mounted).toEqual(['first-response'])
    expect(view.container.querySelector('[data-seat="second-reasoning"]')).toBeNull()
    for (let index = 0; index < 400; index++) {
      await paint()
      if (view.container.querySelector('[data-seat="second-reasoning"]') !== null) break
    }
    expect(mounted).toEqual(['first-response', 'second-reasoning'])
    expect(view.container.querySelector('[data-seat="first-response"]')!.textContent).toBe('a'.repeat(80))
  })

  it('keeps an equal-anchor successor waiting when a member takes over its Flow reservation', async () => {
    const scope = { session: 'presentation-session', turn: '1', step: 1, node: 'first', order: 4 }
    function Reservation() {
      const root = useRef<HTMLDivElement>(null)
      usePresentationAdmission(scope, 'output', true, true, root, false, 'shared-first', true)
      return null
    }
    function Seat({ first, pending }: { first: boolean; pending: boolean }) {
      const root = useRef<HTMLDivElement>(null)
      const admitted = usePresentationAdmission(first ? scope : { ...scope, node: 'second' }, 'output',
        true, pending, root, false, first ? 'shared-first' : 'shared-second')
      return createElement('article', { ref: root, 'data-testid': first ? 'first' : 'second' }, admitted ? 'shown' : '')
    }
    const tree = (reserve: boolean, mounted: boolean, pending: boolean) => createElement('main', null,
      reserve ? createElement(Reservation, { key: 'reservation' }) : null,
      mounted ? createElement(Seat, { key: 'first', first: true, pending }) : null,
      createElement(Seat, { key: 'second', first: false, pending: true }))
    const view = render(tree(true, false, true))
    await act(async () => {})
    expect(view.getByTestId('second').textContent).toBe('')
    view.rerender(tree(true, true, true))
    await act(async () => {})
    expect(view.getByTestId('first').textContent).toBe('shown')
    view.rerender(tree(false, true, true))
    await act(async () => {})
    expect(view.getByTestId('second').textContent).toBe('')
    view.rerender(tree(false, true, false))
    await act(async () => {})
    expect(view.getByTestId('second').textContent).toBe('shown')
  })

  it.each(['replay', 'catch-up', 'latest'] as const)('matches normal creation order for the same source in %s recovery', async mode => {
    const reasoning = 'r'.repeat(80)
    const response = 'a'.repeat(30)
    const tail = 'z'.repeat(20)
    const image = { kind: 'image', attachmentId: 'image-1' } as unknown as AssistantBlock
    const opaque = { kind: 'unknown', payload: { value: 1 } } as unknown as AssistantBlock
    const complete: readonly AssistantBlock[] = [
      { kind: 'reasoning', text: reasoning }, { kind: 'text', text: response },
      image, { kind: 'text', text: tail }, opaque,
    ]
    const run = async (recovering: boolean) => {
      const mounted: string[] = []
      const Atom = ({ name }: { name: string }) => {
        useEffect(() => { mounted.push(name) }, [])
        return createElement('svg', { 'data-atom': name })
      }
      const Inner = (props: Owner) => {
        const part = props.groupPart!
        useEffect(() => { mounted.push(part) }, [])
        return createElement('article', { 'data-seat': part }, createElement('svg', { 'data-header': part }),
          props.node.data.blocks.map((block, index) => {
            if (block.kind === 'reasoning' && part === 'reasoning' || block.kind === 'text' && part === 'response') {
              return createElement('span', { key: index, 'data-block': index }, block.text)
            }
            if (part !== 'response' || block.kind === 'reasoning' || block.kind === 'text') return null
            return createElement(Atom, { key: index, name: block.kind })
          }))
      }
      const initial = owner('shared', 5, [{ kind: 'reasoning', text: 'r'.repeat(20) }], 'reasoning')
      const tree = (blocks: readonly AssistantBlock[], reply: boolean) => createElement('main', null,
        createElement('section', { key: 'reason' }, native({ ...initial, node: { ...initial.node, data: { ...initial.node.data, blocks } } }, Inner, mode)),
        reply ? createElement('section', { key: 'reply' }, native({ ...initial, groupPart: 'response', node: { ...initial.node, data: { ...initial.node.data, status: 'settled', blocks } } }, Inner, mode)) : null)
      const view = render(tree(initial.node.data.blocks, false))
      await paint(3)
      const existing = view.container.querySelector('[data-seat="reasoning"]')
      if (recovering) {
        await act(async () => { window.dispatchEvent(new Event('pagehide')) })
        view.rerender(tree(complete, true))
        expect(view.container.querySelector('[data-header="response"]')).toBeNull()
        await act(async () => { window.dispatchEvent(new Event('pageshow')) })
      } else {
        view.rerender(tree(complete.slice(0, 2), true))
      }
      let suppliedTail = recovering
      for (let index = 0; index < 600; index++) {
        await paint()
        const reason = view.container.querySelector('[data-seat="reasoning"]')
        expect(reason).toBe(existing)
        const reply = view.container.querySelector('[data-seat="response"]')
        if (reply !== null) expect(reason!.textContent, recovering ? 'recovery predecessor' : 'normal predecessor').toBe(reasoning)
        if (!suppliedTail && reply?.textContent === response) {
          suppliedTail = true
          view.rerender(tree(complete, true))
        }
        if (view.container.querySelector('[data-atom="image"]') !== null) {
          expect(view.container.querySelector('[data-seat="response"] [data-block="1"]')!.textContent).toBe(response)
        }
        if (view.container.querySelector('[data-atom="unknown"]') !== null) {
          expect(view.container.querySelector('[data-seat="response"] [data-block="3"]')!.textContent).toBe(tail)
          break
        }
      }
      expect(mounted).toEqual(['reasoning', 'response', 'image', 'unknown'])
      expect(view.container.querySelector('[data-seat="response"]')!.textContent).toBe(response + tail)
      view.unmount()
      assistantProgress.clear()
      streamRelay.clearAll()
      await act(async () => {})
      return mounted
    }
    expect(await run(true)).toEqual(await run(false))
  })

  it('projects a structural prefix without changing indices or opaque block identities', () => {
    const image = { kind: 'image', attachmentId: 'image-1' } as unknown as AssistantBlock
    const opaque = { kind: 'unknown', payload: {} } as unknown as AssistantBlock
    const blocks: readonly AssistantBlock[] = [{ kind: 'text', text: 'first' }, image, { kind: 'text', text: 'last' }, opaque]
    const projection = assistantTextSegments(blocks)
    expect(projectAssistantPresentation(blocks, projection, 'fir')).toEqual([{ kind: 'text', text: 'fir' }])
    const next = projectAssistantPresentation(blocks, projection, 'firstl')
    expect(next).toHaveLength(3)
    expect(next[0]).toBe(blocks[0])
    expect(next[1]).toBe(image)
    expect(next[2]).toEqual({ kind: 'text', text: 'l' })
    expect(projectAssistantPresentation(blocks, projection, 'firstlast')).toBe(blocks)
  })
})
