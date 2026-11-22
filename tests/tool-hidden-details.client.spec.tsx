import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProgressiveDomText } from '../src/client/useProgressiveDomText.ts'
import { clearToolPresentationLedger, wrapFollowNodeView } from '../src/client/TypewriterToolNodeView.tsx'
import { relayScope, streamRelay } from '../src/client/streamRelay.ts'

type Hidden = 'hidden' | 'style' | 'class' | 'details'
let frames: Map<number, FrameRequestCallback>
let time: number
let next: number
async function paint(count = 1) {
  for (let index = 0; index < count; index++) await act(async () => {
    const batch = [...frames.values()]
    frames.clear()
    time += 16
    for (const callback of batch) callback(time)
  })
}
async function flush() { await act(async () => { await Promise.resolve() }) }

beforeEach(() => {
  frames = new Map(); time = 0; next = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = next++; frames.set(id, callback); return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('performance', { now: () => time })
})
afterEach(() => {
  cleanup()
  streamRelay.clearAll()
  clearToolPresentationLedger()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function Probe({ title = 'visible title', body = 'hidden output '.repeat(100), open = false,
  mode = 'hidden', enabled = true, observe = enabled, pending = () => {}, mountOnOpen = false }: {
  title?: string; body?: string; open?: boolean; mode?: Hidden; enabled?: boolean; observe?: boolean
  pending?: (value: boolean) => void; mountOnOpen?: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  const speed = useRef(35)
  useProgressiveDomText(root, enabled, true, speed, undefined, pending, false, 'catch-up', undefined, undefined, observe)
  return <div ref={root} data-tool="bash">
    <div data-disclosure-header><span data-testid="title">{title}</span></div>
    {mode === 'details' ? <details open={open}><summary>Details</summary><pre data-testid="body">{body}</pre></details>
      : !mountOnOpen || open ? <div data-tool-body className={mode === 'class' && !open ? 'test-hidden-details' : 'tool_bodyWrap'}
        hidden={mode === 'hidden' && !open} style={mode === 'style' && !open ? { display: 'none' } : undefined}>
        <pre data-testid="body">{body}</pre>
      </div> : null}
  </div>
}

const Tool = wrapFollowNodeView(props => <div data-tool="bash"><span>{props.text as string}</span>
  <div hidden><pre>{'private details '.repeat(500)}</pre></div></div>, () => false)
function toolNode(status: 'running' | 'complete', id = 'tool:hidden-details') {
  return { key: id, kind: 'tool-call', anchorSeq: 20,
    data: { turn: 7, step: 2, root: status === 'complete' ? { kind: 'tool-result' } : {} },
    location: { kind: 'step', turn: { turn: 7, status: status === 'complete' ? 'closed' : 'open' },
      step: { step: 2, status: status === 'complete' ? 'closed' : 'open' } } }
}

describe('hidden Tool details', () => {
  it.each(['hidden', 'style', 'class'] as const)('releases text hidden by an outer %s Turn container and does not replay it on expansion', async mode => {
    const style = document.createElement('style')
    style.textContent = '.outer-folded-turn { display: none }'
    document.head.appendChild(style)
    try {
      const body = 'pending visible tool output '.repeat(1000)
      const pending = vi.fn()
      const tree = (folded: boolean) => <section hidden={mode === 'hidden' && folded}
        className={mode === 'class' && folded ? 'outer-folded-turn' : ''}
        style={mode === 'style' && folded ? { display: 'none' } : undefined}>
        <Probe title="visible tool summary" body={body} open pending={pending} />
      </section>
      const view = render(tree(false))
      await paint(3)
      expect(view.getByTestId('body').textContent!.length).toBeLessThan(body.length)
      view.rerender(tree(true))
      await flush()
      expect(view.getByTestId('body').textContent).toBe(body)
      expect(pending.mock.calls.at(-1)).toEqual([false])
      await paint(3)
      expect(frames.size).toBe(0)
      view.rerender(tree(false))
      await flush()
      expect(view.getByTestId('body').textContent).toBe(body)
      expect(frames.size).toBe(0)
    } finally { style.remove() }
  })
  it.each(['hidden', 'style', 'class', 'details'] as const)('skips %s bodies while keeping the visible summary live', async mode => {
    const style = document.createElement('style')
    style.textContent = '.test-hidden-details { display: none }'
    document.head.appendChild(style)
    try {
      const pending = vi.fn()
      const body = 'hidden output '.repeat(1000)
      const view = render(<Probe title={'summary '.repeat(20)} body={body} mode={mode} pending={pending} />)
      expect(view.getByTestId('body').textContent).toBe(body)
      expect(view.getByTestId('title').textContent).toBe('')
      await paint(200)
      expect(view.getByTestId('title').textContent).toBe('summary '.repeat(20))
      expect(pending.mock.calls.at(-1)).toEqual([false])
      view.rerender(<Probe title="updated visible summary" body={body + 'new hidden logs'} mode={mode} pending={pending} />)
      await flush()
      expect(view.getByTestId('body').textContent).toBe(body + 'new hidden logs')
      await paint(100)
      expect(view.getByTestId('title').textContent).toBe('updated visible summary')
      expect(pending.mock.calls.at(-1)).toEqual([false])
      expect(frames.size).toBe(0)
    } finally { style.remove() }
  })

  it.each(['hidden', 'style', 'class', 'details'] as const)('opens %s details as a complete snapshot, pacing only later output', async mode => {
    const style = document.createElement('style')
    style.textContent = '.test-hidden-details { display: none }'
    document.head.appendChild(style)
    try {
      const body = 'already received '.repeat(50)
      const view = render(<Probe body={body} mode={mode} />)
      await paint(50)
      view.rerender(<Probe body={body} mode={mode} open />)
      await flush()
      expect(view.getByTestId('body').textContent).toBe(body)
      expect(frames.size).toBe(0)
      const appended = body + 'visible appended output '.repeat(20)
      view.rerender(<Probe body={appended} mode={mode} open />)
      await flush()
      expect(view.getByTestId('body').textContent).toBe(body)
      await paint(3)
      expect(view.getByTestId('body').textContent!.length).toBeGreaterThan(body.length)
      expect(view.getByTestId('body').textContent!.length).toBeLessThan(appended.length)
    } finally { style.remove() }
  })

  it('clears a cached hidden class removed while the observer was inactive', async () => {
    const style = document.createElement('style')
    style.textContent = '.test-hidden-details { display: none }'
    document.head.appendChild(style)
    try {
      const body = 'visible after class removal '.repeat(100)
      const view = render(<Probe mode="class" body={body} />)
      await paint(50)
      view.rerender(<Probe mode="class" body={body} enabled={false} observe={false} />)
      const details = view.getByTestId('body').parentElement!
      details.className = ''
      view.rerender(<Probe mode="class" body={body} />)
      expect(view.getByTestId('body').textContent).toBe('')
      await paint(3)
      expect(view.getByTestId('body').textContent!.length).toBeGreaterThan(0)
      expect(view.getByTestId('body').textContent!.length).toBeLessThan(body.length)
    } finally { style.remove() }
  })

  it('snapshots the ToolRow body mounted by DisclosureRow on expansion', async () => {
    const body = 'existing result '.repeat(100)
    const view = render(<Probe body={body} mountOnOpen />)
    await paint(50)
    view.rerender(<Probe body={body} mountOnOpen open />)
    await flush()
    expect(view.getByTestId('body').textContent).toBe(body)
    expect(frames.size).toBe(0)
  })

  it('does not walk or write a large hidden subtree on hidden output mutations', async () => {
    const view = render(<Probe />)
    await paint(50)
    const body = view.getByTestId('body')
    const walk = vi.spyOn(document, 'createTreeWalker')
    const writes = vi.spyOn(CharacterData.prototype, 'data', 'set')
    await act(async () => { body.textContent = 'large hidden replacement '.repeat(2000) })
    await paint(5)
    expect(walk).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })

  it('restores a partial body once on collapse and removes its reveal budget', async () => {
    const pending = vi.fn()
    const body = 'visible result '.repeat(200)
    const view = render(<Probe body={body} open pending={pending} />)
    await paint(3)
    expect(view.getByTestId('body').textContent).not.toBe(body)
    view.rerender(<Probe body={body} pending={pending} />)
    await flush()
    expect(view.getByTestId('body').textContent).toBe(body)
    await paint(50)
    expect(pending.mock.calls.at(-1)).toEqual([false])
    expect(frames.size).toBe(0)
  })

  it('does not keep a snapshot observer on a terminal static card', async () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    const view = render(<Probe enabled={false} observe={false} />)
    expect(observe).not.toHaveBeenCalled()
    view.rerender(<Probe enabled={false} observe={false} title="terminal summary" body="new hidden result" />)
    await flush()
    expect(view.getByTestId('title').textContent).toBe('terminal summary')
    expect(observe).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })

  it('does not overwrite a newer React body replacement committed with collapse', async () => {
    const view = render(<Probe body={'old streaming result '.repeat(100)} open />)
    await paint(3)
    const replacement = 'new terminal result from React'
    view.rerender(<Probe body={replacement} />)
    await flush()
    expect(view.getByTestId('body').textContent).toBe(replacement)
    view.rerender(<Probe body={replacement} open />)
    await flush()
    expect(view.getByTestId('body').textContent).toBe(replacement)
    await paint(20)
    expect(view.getByTestId('body').textContent).toBe(replacement)
  })

  it('keeps a terminal card native when its full details mount after expansion', async () => {
    const body = 'complete native result '.repeat(200)
    const view = render(<Probe enabled={false} observe={false} body={body} mountOnOpen />)
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    view.rerender(<Probe enabled={false} observe={false} body={body} mountOnOpen open />)
    await flush()
    expect(view.getByTestId('body').textContent).toBe(body)
    expect(observe).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })

  it('snapshots a call container restored from display:none without replaying its old text', async () => {
    const view = render(<Probe title="visible summary" />)
    await paint(50)
    const root = view.container.querySelector('[data-tool]') as HTMLElement
    root.setAttribute('data-chat-call-id', 'conditional-call')
    await act(async () => { root.style.display = 'none' })
    await act(async () => { root.style.display = '' })
    const title = view.getByTestId('title')
    await act(async () => { (title.firstChild as Text).data = 'visible summary new output' })
    expect(title.textContent).toBe('visible summary')
    await paint(3)
    expect(title.textContent!.length).toBeGreaterThan('visible summary'.length)
  })

  it('does not enroll static history merely because an earlier row is active', () => {
    streamRelay.acquire({ session: 'tools', turn: '7', step: 1, node: 'earlier', order: 1 }, 'response', true)
    const subscribe = vi.spyOn(streamRelay, 'subscribeBlocked')
    const acquire = vi.spyOn(streamRelay, 'acquire')
    const view = render(<Tool text="historical summary" sessionId="tools" node={toolNode('complete')} />)
    expect(view.getByText('historical summary')).toBeTruthy()
    expect(subscribe).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-smooth-stream-phase]')?.getAttribute('data-smooth-stream-phase')).toBe('settled')
  })

  it('keeps Tool presence separate from a drained visible summary and retires completed work', async () => {
    const node = toolNode('running')
    const view = render(<Tool text="running summary" sessionId="tools" node={node} />)
    await paint(50)
    const scope = relayScope(node, 'tools')
    expect(streamRelay.hasTool(scope)).toBe(true)
    expect(streamRelay.isBlocked({ ...scope, step: 3, node: 'later', order: 50 }, 'response')).toBe(false)
    view.rerender(<Tool text="finished summary" sessionId="tools" node={toolNode('complete')} />)
    await paint(100)
    expect(view.getByText('finished summary')).toBeTruthy()
    expect(streamRelay.hasTool(scope)).toBe(false)
  })

  it('does not replay an already presented Tool summary after regrouping remounts it', async () => {
    const node = toolNode('running')
    const view = render(<Tool text="already presented" sessionId="tools" node={node} />)
    await paint(50)
    view.unmount()
    const returned = render(<Tool text="already presented" sessionId="tools" node={node} />)
    expect(returned.getByText('already presented')).toBeTruthy()
    expect(returned.container.querySelector('[data-smooth-stream-phase]')?.getAttribute('data-smooth-stream-phase')).toBe('settled')
  })
})
