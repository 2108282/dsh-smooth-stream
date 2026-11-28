import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives/src/DisclosureRow.tsx'
import { StrictMode, useRef, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPlayback, type PlaybackSegment } from '../src/client/sessionPlayback.ts'
import { usePlaybackDomText, type PlaybackDomTextOptions } from '../src/client/usePlaybackDomText.ts'

type Frame = (time: number) => void
let frames: Map<number, Frame>
let time: number
let nextFrame: number
const engines: SessionPlayback[] = []

function engine(): SessionPlayback {
  const playback = new SessionPlayback({
    requestFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id },
    cancelFrame: id => { frames.delete(id) },
    now: () => time,
    charsPerSecond: 1000,
    tuning: { queuePressure: 0, maxRevealCps: 1000, cadenceClamp: 1_000_000 },
  })
  engines.push(playback)
  return playback
}

function Probe({ children, ...props }: Partial<Omit<PlaybackDomTextOptions, 'playback'>> & {
  playback: SessionPlayback
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  usePlaybackDomText(root, {
    owner: 'card:visible', order: [1, 1], animate: true, enabled: true,
    ...props,
  })
  return <div ref={root} data-testid={props.owner ?? 'card:visible'}>{children}</div>
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve()
  })
}

async function paint(milliseconds = 1): Promise<void> {
  await act(async () => {
    time += milliseconds
    const batch = [...frames.values()]
    frames.clear()
    for (const frame of batch) frame(time)
  })
}

function registered(spy: ReturnType<typeof vi.spyOn>, owner = 'card:visible'): readonly PlaybackSegment[] {
  const call = [...spy.mock.calls].reverse().find(call => call[0] === owner)
  return call?.[1] as readonly PlaybackSegment[] ?? []
}

beforeEach(() => {
  frames = new Map()
  time = 0
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => { throw new Error('DOM bridge must use the session clock') }))
})

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  for (const playback of engines.splice(0)) playback.dispose()
  frames.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('usePlaybackDomText', () => {
  it('registers Unicode Text segments before releasing atomic entry and keeps successors in the shared queue', async () => {
    const playback = engine()
    playback.upsert('atomic', [{ id: 'atomic', order: [1, 0], text: '', sealed: true, awaitPresentation: true }], true)
    playback.upsert('tail', [{ id: 'tail', order: [2], text: 'tail', sealed: true }], true)
    await settle()
    const upsert = vi.spyOn(playback, 'upsert')
    const onReady = vi.fn(() => {
      expect(registered(upsert).map(source => source.text)).toEqual(['😀a', 'b'])
      playback.acknowledgePresentation('atomic')
    })
    const view = render(<Probe playback={playback} onReady={onReady}><span>😀a</span><em>b</em></Probe>)
    const span = view.container.querySelector('span')!
    const text = span.firstChild
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(span.textContent).toBe('')
    await settle()
    expect(frames.size).toBe(1)
    await paint()
    expect(span.firstChild).toBe(text)
    expect(span.textContent).toBe('😀')
    expect(view.container.querySelector('em')!.textContent).toBe('')
    expect(playback.read('tail').entered).toBe(false)
    await paint()
    expect(span.textContent).toBe('😀a')
    await paint()
    expect(view.container.querySelector('em')!.textContent).toBe('b')
    expect(playback.read('tail').text).toBe('')
    await paint()
    expect(playback.read('tail').text).toBe('t')
  })

  it('serializes separate renderer owners by their provided source order', async () => {
    const playback = engine()
    const view = render(<>
      <Probe playback={playback} owner="second" order={[2, 1]}><span>XY</span></Probe>
      <Probe playback={playback} owner="first" order={[1, 1]}><span>ab</span></Probe>
    </>)
    await settle()
    await paint()
    expect(view.getByTestId('first').textContent).toBe('a')
    expect(view.getByTestId('second').textContent).toBe('')
    await paint()
    expect(view.getByTestId('first').textContent).toBe('ab')
    await paint()
    expect(view.getByTestId('second').textContent).toBe('X')
  })

  it('keeps full host text through React appends and ignores its own observer writes', async () => {
    const playback = engine()
    const upsert = vi.spyOn(playback, 'upsert')
    const view = render(<Probe playback={playback}><span>abcd</span></Probe>)
    await settle()
    const initialRegistrations = upsert.mock.calls.length
    await paint()
    expect(view.container.querySelector('span')!.textContent).toBe('a')
    expect(upsert.mock.calls.length).toBe(initialRegistrations)
    view.rerender(<Probe playback={playback}><span>abcdef</span></Probe>)
    await settle()
    expect(registered(upsert)[0]!.text).toBe('abcdef')
    expect(view.container.querySelector('span')!.textContent).toBe('a')
    await paint(5)
    expect(view.container.querySelector('span')!.textContent).toBe('abcdef')
    const doneRegistrations = upsert.mock.calls.length
    await settle()
    expect(upsert.mock.calls.length).toBe(doneRegistrations)
  })

  it('distinguishes host edits and internal writes delivered in the same observer batch', async () => {
    const playback = engine()
    let replaceAfterCommit = false
    let node: Text | undefined
    const onCommit = () => {
      if (!replaceAfterCommit || node === undefined) return
      replaceAfterCommit = false
      node.data = 'abcXYZ'
      node.data = 'abcXYZq'
    }
    const upsert = vi.spyOn(playback, 'upsert')
    const view = render(<Probe playback={playback} onCommit={onCommit}><span>abc</span></Probe>)
    node = view.container.querySelector('span')!.firstChild as Text
    await settle()
    replaceAfterCommit = true
    await paint()
    expect(registered(upsert)[0]!.text).toBe('abcXYZq')
    expect(node.data).toBe('a')
    await paint(6)
    expect(node.data).toBe('abcXYZq')
  })

  it('adopts an explicit native truncation even when it equals the current displayed prefix', async () => {
    const playback = engine()
    const upsert = vi.spyOn(playback, 'upsert')
    const view = render(<Probe playback={playback}><span>abcd</span></Probe>)
    await settle()
    await paint()
    const node = view.container.querySelector('span')!.firstChild as Text
    expect(node.data).toBe('a')
    node.data = 'a'
    await settle()
    expect(registered(upsert)[0]!.text).toBe('a')
    await paint(10)
    expect(node.data).toBe('a')
  })

  it('resets an unfinished non-prefix replacement without leaking the former full source', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback}><span>abcd</span></Probe>)
    await settle()
    await paint()
    view.rerender(<Probe playback={playback}><span>😀xy</span></Probe>)
    await settle()
    expect(view.container.querySelector('span')!.textContent).toBe('')
    await paint()
    expect(view.container.querySelector('span')!.textContent).toBe('😀')
    await paint(2)
    expect(view.container.querySelector('span')!.textContent).toBe('😀xy')
    view.rerender(<Probe playback={playback}><span>finished replacement</span></Probe>)
    await settle()
    expect(view.container.querySelector('span')!.textContent).toBe('finished replacement')
  })

  it('adopts only the initial baseline and animates later Unicode suffixes and new nodes', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback} revealInitial={false}><span>😀</span></Probe>)
    expect(view.container.querySelector('span')!.textContent).toBe('😀')
    await settle()
    expect(frames.size).toBe(0)
    view.rerender(<Probe playback={playback} revealInitial={false}><span>😀xy</span><em>z</em></Probe>)
    await settle()
    expect(view.container.querySelector('span')!.textContent).toBe('😀')
    expect(view.container.querySelector('em')!.textContent).toBe('')
    await paint()
    expect(view.container.querySelector('span')!.textContent).toBe('😀x')
    await paint()
    await paint()
    expect(view.container.textContent).toBe('😀xyz')
  })

  it('skips DOM observation for static history cards under shared ancestor transforms', async () => {
    const playback = engine()
    const upsert = vi.spyOn(playback, 'upsert')
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    const values = Array.from({ length: 20 }, (_, index) => `history-${index}`)
    const view = render(<section data-testid="shared-transcript">
      {values.map((value, index) => <Probe key={index} playback={playback} owner={`history:${index}`}
        order={[index]} animate={false}><span>{value}</span></Probe>)}
    </section>)
    await settle()

    expect(view.getByTestId('shared-transcript').textContent).toBe(values.join(''))
    expect(upsert).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()

    view.getByTestId('shared-transcript').setAttribute('style', 'transform: translate3d(0, 12px, 0); will-change: transform')
    await settle()
    expect(upsert).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
  })

  it('leaves history, input controls, SVG, live regions, and button names native', async () => {
    const playback = engine()
    const upsert = vi.spyOn(playback, 'upsert')
    const click = vi.fn()
    const view = render(<Probe playback={playback} animate={false}>
      <span>history</span><button onClick={click}>Open details</button>
      <span aria-live="polite">announcement</span><textarea defaultValue="editor" />
      <input defaultValue="input" /><svg><text>icon</text></svg>
      <span contentEditable suppressContentEditableWarning>editable</span>
    </Probe>)
    const html = view.container.innerHTML
    await settle()
    expect(view.container.innerHTML).toBe(html)
    expect(registered(upsert)).toEqual([])
    expect(frames.size).toBe(0)
    fireEvent.click(view.getByRole('button', { name: 'Open details' }))
    expect(click).toHaveBeenCalledTimes(1)
    view.rerender(<Probe playback={playback}><button onClick={click}>Open details</button><span>live</span></Probe>)
    await settle()
    expect(view.getByRole('button', { name: 'Open details' })).toBeTruthy()
  })

  it('does not spend budget on folded details and snapshots expansion before pacing later output', async () => {
    const playback = engine()
    const upsert = vi.spyOn(playback, 'upsert')
    const view = render(<Probe playback={playback}>
      <span>ab</span><details><summary>Expand</summary><pre>{'hidden'.repeat(200)}</pre></details><em>z</em>
    </Probe>)
    await settle()
    expect(registered(upsert).map(source => source.text)).toEqual(['ab', 'Expand', 'z'])
    await paint(3)
    expect(view.container.querySelector('em')!.textContent).toBe('z')
    const details = view.container.querySelector('details')!
    details.open = true
    await settle()
    const pre = view.container.querySelector('pre')!
    expect(pre.textContent).toBe('hidden'.repeat(200))
    expect(frames.size).toBe(0)
    ;(pre.firstChild as Text).data += 'XY'
    await settle()
    expect(pre.textContent).toBe('hidden'.repeat(200))
    await paint()
    expect(pre.textContent).toBe(`${'hidden'.repeat(200)}X`)
  })

  it('snapshots a previously hidden ancestor and preserves native hidden text while folded', async () => {
    const playback = engine()
    const view = render(<section hidden><Probe playback={playback}><span>abcdef</span></Probe></section>)
    await settle()
    expect(frames.size).toBe(0)
    expect(view.container.querySelector('span')!.textContent).toBe('abcdef')
    view.container.querySelector('section')!.hidden = false
    await settle()
    expect(view.container.querySelector('span')!.textContent).toBe('abcdef')
    expect(frames.size).toBe(0)
  })

  it('snapshots a DisclosureRow detail body mounted by the host on expansion', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback}><div data-tool="read"><button>Expand</button></div></Probe>)
    await settle()
    view.rerender(<Probe playback={playback}><div data-tool="read"><button>Collapse</button><pre data-tool-body>large existing result</pre></div></Probe>)
    await settle()
    expect(view.container.querySelector('pre')!.textContent).toBe('large existing result')
    expect(frames.size).toBe(0)
  })

  it('snapshots the shipped DisclosureRow on expansion and animates only later body changes', async () => {
    const playback = engine()
    const body = 'native existing result'
    const toggle = vi.fn()
    const tree = (open: boolean, text = body, extra: ReactNode = null) => <Probe playback={playback}>
      <DisclosureRow icon={null} title="Details" open={open} expandable expandOnRowClick onToggle={toggle}>
        <pre>{text}</pre>{extra}
      </DisclosureRow>
    </Probe>
    const view = render(tree(false))
    await settle()
    fireEvent.click(view.getByRole('button', { name: 'Details' }))
    expect(toggle).toHaveBeenCalledTimes(1)
    view.rerender(tree(true))
    await settle()
    expect(view.container.querySelector('pre')!.textContent).toBe(body)
    expect(frames.size).toBe(0)
    view.rerender(tree(true, `${body}XY`, <em>z</em>))
    await settle()
    expect(view.container.querySelector('pre')!.textContent).toBe(body)
    expect(view.container.querySelector('em')!.textContent).toBe('')
    await paint()
    expect(view.container.querySelector('pre')!.textContent).toBe(`${body}X`)
    await paint(2)
    expect(view.container.querySelector('pre')!.textContent).toBe(`${body}XY`)
    expect(view.container.querySelector('em')!.textContent).toBe('z')
  })

  it('snapshots direct Text children on native disclosure expansion', async () => {
    const playback = engine()
    const tree = (open: boolean, text = 'inline history') => <Probe playback={playback}>
      <DisclosureRow icon={null} title="Details" open={open} expandable expandOnRowClick onToggle={() => {}}>{text}</DisclosureRow>
    </Probe>
    const view = render(tree(false))
    await settle()
    view.rerender(tree(true))
    await settle()
    expect(view.container.textContent).toBe('Detailsinline history')
    expect(frames.size).toBe(0)
    view.rerender(tree(true, 'inline historyX'))
    await settle()
    expect(view.container.textContent).toBe('Detailsinline history')
    await paint()
    expect(view.container.textContent).toBe('Detailsinline historyX')
  })

  it('paces an initially open native DisclosureRow rather than adopting new card output', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback}>
      <DisclosureRow icon={null} title="Details" open expandable onToggle={() => {}}><pre>ab</pre></DisclosureRow>
    </Probe>)
    await settle()
    expect(view.container.querySelector('pre')!.textContent).toBe('')
    await paint(100)
    expect(view.container.querySelector('pre')!.textContent).toBe('ab')
  })

  it('rebinds changed owners and sessions without losing the renderer source', async () => {
    const first = engine()
    const second = engine()
    const remove = vi.spyOn(first, 'remove')
    const ready = vi.fn()
    const view = render(<Probe playback={first} onReady={ready}><span>abcd</span></Probe>)
    await settle()
    await paint()
    const node = view.container.querySelector('span')!.firstChild
    expect(node!.textContent).toBe('a')
    view.rerender(<Probe playback={first} owner="replacement" onReady={ready}><span>abcd</span></Probe>)
    await settle()
    expect(remove).toHaveBeenCalledWith('card:visible')
    expect(node!.textContent).toBe('')
    await paint()
    expect(node!.textContent).toBe('a')
    view.rerender(<Probe playback={second} owner="replacement" onReady={ready}><span>abcd</span></Probe>)
    await settle()
    expect(remove).toHaveBeenCalledWith('replacement')
    expect(node!.textContent).toBe('')
    expect(view.container.querySelector('span')!.firstChild).toBe(node)
    expect(ready).toHaveBeenCalledTimes(3)
    await paint(4)
    expect(node!.textContent).toBe('abcd')
  })

  it('restores full source on disable and resumes with a fresh native snapshot when requested', async () => {
    const playback = engine()
    const remove = vi.spyOn(playback, 'remove')
    const view = render(<Probe playback={playback}><span>abcd</span></Probe>)
    await settle()
    await paint()
    view.rerender(<Probe playback={playback} enabled={false}><span>new terminal result</span></Probe>)
    await settle()
    expect(view.container.querySelector('span')!.textContent).toBe('new terminal result')
    expect(remove).toHaveBeenCalledWith('card:visible')
    expect(frames.size).toBe(0)
    view.rerender(<Probe playback={playback} revealInitial={false}><span>new terminal result</span></Probe>)
    await settle()
    expect(view.container.querySelector('span')!.textContent).toBe('new terminal result')
  })

  it('reuses structural segment identity across remounts and survives StrictMode cleanup', async () => {
    const playback = engine()
    const upsert = vi.spyOn(playback, 'upsert')
    const remove = vi.spyOn(playback, 'remove')
    const first = render(<StrictMode><Probe playback={playback}><span>abcd</span></Probe></StrictMode>)
    await settle()
    const id = registered(upsert)[0]!.id
    await paint()
    expect(first.container.querySelector('span')!.textContent).toBe('a')
    const oldText = first.container.querySelector('span')!.firstChild as Text
    first.unmount()
    expect(oldText.data).toBe('abcd')
    await settle()
    expect(frames.size).toBe(0)
    const second = render(<StrictMode><Probe playback={playback}><span>abcd</span></Probe></StrictMode>)
    await settle()
    expect(registered(upsert)[0]!.id).toBe(id)
    expect(second.container.querySelector('span')!.textContent).toBe('a')
    await paint()
    expect(second.container.querySelector('span')!.textContent).toBe('ab')
    second.unmount()
    await settle()
    expect(frames.size).toBe(0)
    expect(remove).toHaveBeenCalled()
  })

  it('reports pending transitions only on changes and commits only after real visible writes', async () => {
    const playback = engine()
    const pending = vi.fn()
    const commit = vi.fn()
    const view = render(<Probe playback={playback} onPendingChange={pending} onCommit={commit}><span>ab</span></Probe>)
    await settle()
    expect(pending.mock.calls).toEqual([[true]])
    expect(commit).toHaveBeenCalledTimes(1)
    await paint()
    expect(pending.mock.calls).toEqual([[true]])
    await paint()
    expect(pending.mock.calls).toEqual([[true], [false]])
    const commits = commit.mock.calls.length
    view.rerender(<Probe playback={playback} onPendingChange={pending} onCommit={commit}><span>ab</span></Probe>)
    await settle()
    expect(commit).toHaveBeenCalledTimes(commits)
    expect(pending.mock.calls).toEqual([[true], [false]])
  })

  it('rehides later renderer text on source growth and restores its consumed progress without replay', async () => {
    const playback = engine()
    const upsert = vi.spyOn(playback, 'upsert')
    const view = render(<Probe playback={playback}><span>a</span><em>bc</em></Probe>)
    await settle()
    await paint(3)
    expect(view.container.textContent).toBe('abc')
    view.rerender(<Probe playback={playback}><span>aXY</span><em>bc</em></Probe>)
    await settle()
    expect(view.container.querySelector('span')!.textContent).toBe('a')
    expect(view.container.querySelector('em')!.textContent).toBe('')
    expect(registered(upsert).map(source => source.text)).toEqual(['aXY', 'bc'])
    await paint(2)
    expect(view.container.querySelector('span')!.textContent).toBe('aXY')
    expect(view.container.querySelector('em')!.textContent).toBe('bc')
  })
})
