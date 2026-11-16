import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import type { AssistantBlock, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NativeAssistantNodeView,
  assistantTextSegments,
  revealAssistantBlocks,
  type AssistantTextProjection,
} from '../src/client/NativeAssistantNodeView.tsx'
import { streamRelay } from '../src/client/streamRelay.ts'
import { DEFAULT_STREAM_SETTINGS } from '../src/settings.ts'

afterEach(() => {
  cleanup()
  streamRelay.clearAll()
  vi.unstubAllGlobals()
})

function text(block: AssistantBlock | undefined): string | undefined {
  return block?.kind === 'text' || block?.kind === 'reasoning' ? block.text : undefined
}

function selectedText(blocks: readonly AssistantBlock[], indices: readonly number[]): string {
  return indices.map(index => text(blocks[index]) ?? '').join('')
}

describe('assistant source projection', () => {
  it('reveals every Unicode code-point prefix across multiple blocks without splitting emoji', () => {
    const blocks: readonly AssistantBlock[] = [
      { kind: 'reasoning', text: '想🧠好' },
      { kind: 'text', text: 'A😀e\u0301' },
      { kind: 'text', text: '👨\u200d👩\u200d👧结束' },
    ]
    const projection = assistantTextSegments(blocks)
    const chars = [...projection.segments.join('')]
    for (let count = 0; count <= chars.length; count += 1) {
      const shown = chars.slice(0, count).join('')
      const visible = revealAssistantBlocks(blocks, projection, shown)
      expect(selectedText(visible, projection.blockIndices)).toBe(shown)
      for (const block of visible) {
        expect(text(block)?.endsWith('\uD83D')).not.toBe(true)
      }
    }
    expect(revealAssistantBlocks(blocks, projection, chars.join(''))).toBe(blocks)
  })

  it.each(['reasoning', 'response'] as const)('changes only the selected %s group and retains opaque blocks', groupPart => {
    const opaque = { kind: 'unknown', block: { payload: { arbitrary: true } } } as unknown as AssistantBlock
    const blocks: readonly AssistantBlock[] = [
      { kind: 'reasoning', text: '思😀考' },
      opaque,
      { kind: 'text', text: '答🧠案' },
    ]
    const projection = assistantTextSegments(blocks, groupPart)
    const selected = groupPart === 'reasoning' ? 0 : 2
    const untouched = groupPart === 'reasoning' ? 2 : 0
    const shown = [...(text(blocks[selected]) ?? '')].slice(0, 2).join('')
    const visible = revealAssistantBlocks(blocks, projection, shown)
    expect(text(visible[selected])).toBe(shown)
    expect(visible[untouched]).toBe(blocks[untouched])
    expect(visible[1]).toBe(opaque)
    expect(visible).toHaveLength(blocks.length)
  })

  it('keeps completed and unchanged pending block identities while advancing the current block', () => {
    const metadata = { format: 'opaque', nested: { keep: true } }
    const first = { kind: 'text', text: 'done😀', metadata } as AssistantBlock
    const current = { kind: 'text', text: 'abcdef', metadata } as AssistantBlock
    const later = { kind: 'reasoning', text: 'later🧠', metadata } as AssistantBlock
    const blocks = [first, current, later]
    const projection = assistantTextSegments(blocks)
    const a = revealAssistantBlocks(blocks, projection, 'done😀a')
    const b = revealAssistantBlocks(blocks, projection, 'done😀ab')
    const repeated = revealAssistantBlocks(blocks, projection, 'done😀ab')
    expect(a[0]).toBe(first)
    expect(b[0]).toBe(first)
    expect(a[1]).not.toBe(b[1])
    expect(a[2]).toBe(b[2])
    expect(repeated[1]).toBe(b[1])
    expect(repeated[2]).toBe(b[2])
    expect(b[1]).toMatchObject({ text: 'ab', metadata })
    expect((b[1] as unknown as { metadata: unknown }).metadata).toBe(metadata)
    const complete = revealAssistantBlocks(blocks, projection, 'done😀abcdeflater🧠')
    expect(complete).toBe(blocks)
    expect(complete[1]).toBe(current)
    expect(complete[2]).toBe(later)
  })

  it('refreshes partial block metadata when its source identity changes', () => {
    const old: AssistantBlock & { revision: number } = { kind: 'text', text: 'abcdef', revision: 1 }
    const projection = assistantTextSegments([old])
    const a = revealAssistantBlocks([old], projection, 'ab')
    const updated: AssistantBlock & { revision: number } = { ...old, revision: 2 }
    const b = revealAssistantBlocks([updated], projection, 'ab')
    expect(b[0]).not.toBe(a[0])
    expect(b[0]).toMatchObject({ text: 'ab', revision: 2 })
  })

  it('accepts the existing hand-built projection shape and clamps an incomplete surrogate prefix', () => {
    const blocks: readonly AssistantBlock[] = [{ kind: 'text', text: 'A😀B' }]
    const projection: AssistantTextProjection = { segments: ['A😀B'], blockIndices: [0] }
    expect(text(revealAssistantBlocks(blocks, projection, 'A\uD83D')[0])).toBe('A')
    expect(text(revealAssistantBlocks(blocks, projection, 'A😀')[0])).toBe('A😀')
  })

  it('joins the source once and never iterates full strings during repeated reveal frames', () => {
    const source = '😀长正文'.repeat(2000)
    const blocks: readonly AssistantBlock[] = [{ kind: 'text', text: source }]
    const projection = assistantTextSegments(blocks)
    const join = vi.spyOn(projection.segments, 'join')
    const iterator = vi.spyOn(String.prototype, Symbol.iterator)
    let displayed: readonly AssistantBlock[] = blocks
    try {
      for (let end = 2; end <= 202; end += 5) {
        displayed = revealAssistantBlocks(blocks, projection, source.slice(0, end))
      }
      expect(iterator).not.toHaveBeenCalled()
      expect(join).toHaveBeenCalledTimes(1)
    } finally {
      iterator.mockRestore()
      join.mockRestore()
    }
    expect(text(displayed[0])).toBe(source.slice(0, 202))
  })

  it('returns the original array when the selected group has no text or is already complete', () => {
    const reasoning: AssistantBlock = { kind: 'reasoning', text: 'thought' }
    const blocks: readonly AssistantBlock[] = [reasoning, { kind: 'text', text: '' }]
    expect(revealAssistantBlocks(blocks, assistantTextSegments(blocks, 'response'), '')).toBe(blocks)
    expect(revealAssistantBlocks(blocks, assistantTextSegments(blocks), 'thought')).toBe(blocks)
  })
})

describe('assistant waiting presentation', () => {
  it.each([true, false])('hides official chrome behind an earlier tool with keepStreamOnToolCall=%s', keepStreamOnToolCall => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const scope = { session: 'session', turn: '1', step: 1, node: 'tool:1', order: 1 }
    const tool = streamRelay.acquire(scope, 'tool', true)
    const owner = {
      sessionId: 'session',
      node: {
        key: 'assistant:2', anchorSeq: 2, location: { kind: 'unresolved' },
        data: { turn: 1, step: 2, status: 'running', blocks: [{ kind: 'text', text: 'next response' }] },
      },
      useDisclosure: () => ({ expanded: false, setExpanded: () => {}, toggle: () => {} }),
    } as unknown as ChatNodeViewProps<'assistant-step'>
    const Inner = () => createElement('aside', null, 'official chrome')
    const view = render(createElement(NativeAssistantNodeView, {
      Inner, owner,
      preferences: { ...DEFAULT_STREAM_SETTINGS, controlScroll: false, logarithmicFade: false,
        preset: 'balanced', keepStreamOnToolCall },
    }))
    const root = view.container.querySelector<HTMLElement>('[data-smooth-stream-phase]')!
    expect(root.dataset.smoothStreamPhase).toBe('waiting')
    expect(root.style.height).toBe('0px')
    expect(root.style.opacity).toBe('0')
    expect(root.hasAttribute('data-smooth-stream-typing')).toBe(false)
    // A later tool presence must not reverse-block this assistant during handoff.
    let laterTool: symbol
    act(() => { laterTool = streamRelay.acquire({ ...scope, step: 2, node: 'tool:2', order: 3 }, 'tool', true) })
    act(() => streamRelay.release(tool))
    expect(root.dataset.smoothStreamPhase).not.toBe('waiting')
    expect(root.style.opacity).toBe('')
    expect(view.getByText('official chrome')).toBeTruthy()
    act(() => streamRelay.release(laterTool))
  })
})
