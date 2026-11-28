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

function patched(spy: ReturnType<typeof vi.spyOn>, owner = 'card:visible'): readonly PlaybackSegment[] {
  const call = [...spy.mock.calls].reverse().find(call => call[0] === owner)
  return call?.[1] as readonly PlaybackSegment[] ?? []
}

function watchTextData(text: Text): { reads: () => number; restore: () => void } {
  let prototype: object | null = Object.getPrototypeOf(text)
  let descriptor: PropertyDescriptor | undefined
  while (prototype !== null && descriptor === undefined) {
    descriptor = Object.getOwnPropertyDescriptor(prototype, 'data')
    prototype = Object.getPrototypeOf(prototype)
  }
  if (descriptor?.get === undefined || descriptor.set === undefined) throw new Error('Text.data descriptor unavailable')
  let reads = 0
  Object.defineProperty(text, 'data', {
    configurable: true,
    get() { reads++; return descriptor!.get!.call(text) },
    set(value: string) { descriptor!.set!.call(text, value) },
  })
  return {
    reads: () => reads,
    restore: () => { delete (text as unknown as Record<string, unknown>).data },
  }
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

  it('presents only playback-dirty text nodes instead of reading every indexed node', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback}>
      <span data-testid="active">ab</span><span data-testid="idle">cd</span>
    </Probe>)
    await settle()
    const idle = view.getByTestId('idle').firstChild as Text
    let prototype: object | null = Object.getPrototypeOf(idle)
    let descriptor: PropertyDescriptor | undefined
    while (prototype !== null && descriptor === undefined) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, 'data')
      prototype = Object.getPrototypeOf(prototype)
    }
    if (descriptor?.get === undefined || descriptor.set === undefined) throw new Error('Text.data descriptor unavailable')
    let reads = 0
    Object.defineProperty(idle, 'data', {
      configurable: true,
      get() { reads++; return descriptor!.get!.call(idle) },
      set(value: string) { descriptor!.set!.call(idle, value) },
    })
    await paint()
    expect(view.getByTestId('active').textContent).toBe('a')
    expect(reads).toBe(0)
    delete (idle as unknown as Record<string, unknown>).data
  })

  it('registers appended subtrees without reading unrelated indexed text nodes', async () => {
    const playback = engine()
    const patch = vi.spyOn(playback, 'patch')
    const view = render(<Probe playback={playback}>
      <span>ab</span><span data-testid="idle">cd</span>
    </Probe>)
    await settle()
    const idle = watchTextData(view.getByTestId('idle').firstChild as Text)
    const root = view.getByTestId('card:visible')
    const appended = document.createElement('strong')
    appended.textContent = 'new'
    act(() => root.appendChild(appended))
    await settle()
    expect(patched(patch).map(segment => segment.text)).toEqual(['new'])
    expect(appended.textContent).toBe('')
    expect(idle.reads()).toBe(0)
    idle.restore()
  })

  it('rescans only a replaced subtree and removes its former sources', async () => {
    const playback = engine()
    const patch = vi.spyOn(playback, 'patch')
    const view = render(<Probe playback={playback}>
      <section data-testid="target"><span>old text</span></section>
      <aside data-testid="idle">idle text</aside>
    </Probe>)
    await settle()
    const idle = watchTextData(view.getByTestId('idle').firstChild as Text)
    const target = view.getByTestId('target')
    const replacement = document.createElement('strong')
    replacement.textContent = 'replacement'
    act(() => target.replaceChildren(replacement))
    await settle()
    expect(registered(patch).map(segment => segment.text)).toEqual(['replacement'])
    expect(patch.mock.calls.at(-1)?.[2]).toHaveLength(1)
    expect(replacement.textContent).toBe('')
    expect(idle.reads()).toBe(0)
    idle.restore()
  })

  it('snapshots newly appended hidden subtrees on later reveal without scanning siblings', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback} revealInitial={false}>
      <span>history</span><aside data-testid="idle">idle</aside>
    </Probe>)
    await settle()
    const idle = watchTextData(view.getByTestId('idle').firstChild as Text)
    const hidden = document.createElement('section')
    hidden.hidden = true
    hidden.innerHTML = '<span>folded history</span>'
    act(() => view.getByTestId('card:visible').appendChild(hidden))
    await settle()
    expect(hidden.textContent).toBe('folded history')
    act(() => { hidden.hidden = false })
    await settle()
    expect(hidden.textContent).toBe('folded history')
    expect(idle.reads()).toBe(0)
    idle.restore()
  })

  it('rescans only an attribute-affected subtree while preserving its native text snapshot', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback}>
      <section data-testid="target"><span>local result</span></section>
      <aside data-testid="idle">unrelated result</aside>
    </Probe>)
    await settle()
    const idle = watchTextData(view.getByTestId('idle').firstChild as Text)
    const target = view.getByTestId('target')
    act(() => { target.hidden = true })
    await settle()
    expect(target.textContent).toBe('local result')
    act(() => { target.hidden = false })
    await settle()
    expect(target.textContent).toBe('local result')
    expect(idle.reads()).toBe(0)
    idle.restore()
  })

  it('recomputes Unicode history baseline after an unfinished non-prefix edit', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback} revealInitial={false}><span>😀abc</span></Probe>)
    await settle()
    view.rerender(<Probe playback={playback} revealInitial={false}><span>😀abcX</span></Probe>)
    await settle()
    view.rerender(<Probe playback={playback} revealInitial={false}><span>😀aYZ</span></Probe>)
    await settle()
    expect(view.container.querySelector('span')!.textContent).toBe('😀a')
  })

  it('restores the current prefix when the host rewrites an unchanged full source', async () => {
    const playback = engine()
    playback.upsert('gate', [{ id: 'gate', order: [0], text: '', sealed: false }], true)
    await settle()
    const view = render(<Probe playback={playback} order={[1]}><span>abcd</span></Probe>)
    await settle()
    const node = view.container.querySelector('span')!.firstChild as Text
    expect(node.data).toBe('')
    act(() => { node.data = 'abcd' })
    await settle()
    expect(node.data).toBe('')
  })

  it('adopts changed button labels immediately and refreshes queue order without a DOM rescan', async () => {
    const playback = engine()
    const patch = vi.spyOn(playback, 'patch')
    const buttonView = render(<Probe playback={playback}><button>Open</button></Probe>)
    await settle()
    buttonView.rerender(<Probe playback={playback}><button>Open more</button></Probe>)
    await settle()
    expect(buttonView.getByRole('button').textContent).toBe('Open more')
    expect(frames.size).toBe(0)

    const orderView = render(<>
      <Probe playback={playback} owner="order:first" order={[1]}><span>A</span></Probe>
      <Probe playback={playback} owner="order:second" order={[2]}><span>B</span></Probe>
    </>)
    await settle()
    orderView.rerender(<>
      <Probe playback={playback} owner="order:first" order={[3]}><span>A</span><i /></Probe>
      <Probe playback={playback} owner="order:second" order={[2]}><span>B</span></Probe>
    </>)
    await settle()
    expect(registered(patch, 'order:first')[0]!.order).toEqual([3, 0])
    await paint()
    expect(orderView.getByTestId('order:first').textContent).toBe('')
    expect(orderView.getByTestId('order:second').textContent).toBe('B')
  })

  it('preserves source identities on remount after inserting a preceding sibling', async () => {
    const playback = engine()
    const upsert = vi.spyOn(playback, 'upsert')
    const first = render(<Probe playback={playback}><span>abcd</span><aside>efgh</aside></Probe>)
    await settle()
    const before = new Map(registered(upsert).map(segment => [segment.text, segment.id]))
    await paint(5)
    const addition = document.createElement('em')
    addition.textContent = 'new'
    act(() => first.getByTestId('card:visible').prepend(addition))
    await settle()
    first.unmount()
    await settle()
    const second = render(<Probe playback={playback}><em>new</em><span>abcd</span><aside>efgh</aside></Probe>)
    await settle()
    const after = new Map(registered(upsert).map(segment => [segment.text, segment.id]))
    expect(after.get('abcd')).toBe(before.get('abcd'))
    expect(after.get('efgh')).toBe(before.get('efgh'))
    await paint(3)
    expect(second.container.querySelector('span')!.textContent).toBe('abcd')
    expect(second.container.querySelector('aside')!.textContent).toBe('e')
  })

  it('keeps hidden snapshots associated with their nodes after a sibling insertion', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback}>
      <span>active</span><section data-testid="hidden" hidden>hidden history</section>
    </Probe>)
    await settle()
    const addition = document.createElement('em')
    addition.textContent = 'new'
    act(() => view.getByTestId('card:visible').prepend(addition))
    await settle()
    act(() => { view.getByTestId('hidden').hidden = false })
    await settle()
    expect(view.getByTestId('hidden').textContent).toBe('hidden history')
  })

  it('does not adopt live content inserted at a former hidden sibling path', async () => {
    const playback = engine()
    const patch = vi.spyOn(playback, 'patch')
    const view = render(<Probe playback={playback}>
      <section data-testid="hidden" hidden>hidden history</section><aside>active</aside>
    </Probe>)
    await settle()
    const addition = document.createElement('section')
    addition.textContent = 'brand new live output'
    act(() => view.getByTestId('card:visible').prepend(addition))
    await settle()
    expect(addition.textContent).toBe('')
    expect(registered(patch).find(segment => segment.text === 'brand new live output')?.baselineChars).toBeUndefined()
    act(() => { view.getByTestId('hidden').hidden = false })
    await settle()
    expect(view.getByTestId('hidden').textContent).toBe('hidden history')
  })

  it('updates host text without re-registering or reading unchanged nodes', async () => {
    const playback = engine()
    const upsert = vi.spyOn(playback, 'upsert')
    const update = vi.spyOn(playback, 'updateSegments')
    const tree = (text: string) => <Probe playback={playback}><span>{text}</span><aside data-testid="idle">idle</aside></Probe>
    const view = render(tree('ab'))
    await settle()
    const idle = watchTextData(view.getByTestId('idle').firstChild as Text)
    view.rerender(tree('abcd'))
    await settle()
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(registered(update).map(segment => segment.text)).toEqual(['abcd'])
    expect(idle.reads()).toBe(0)
    idle.restore()
  })

  it('does no DOM text work on an unchanged renderer commit', async () => {
    const playback = engine()
    const tree = () => <Probe playback={playback}><span data-testid="text">abcd</span></Probe>
    const view = render(tree())
    await settle()
    const text = watchTextData(view.getByTestId('text').firstChild as Text)
    view.rerender(tree())
    await settle()
    expect(text.reads()).toBe(0)
    text.restore()
  })

  it('keeps an empty displayed Text binding when moving its subtree', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback}><span data-testid="moving">ab</span><aside data-testid="target" /></Probe>)
    await settle()
    const moving = view.getByTestId('moving')
    expect(moving.textContent).toBe('')
    act(() => view.getByTestId('target').appendChild(moving))
    await settle()
    expect(moving.textContent).toBe('')
    await paint(2)
    expect(moving.textContent).toBe('ab')
  })

  it('inherits hidden ancestors when a descendant changes attributes or text', async () => {
    const playback = engine()
    const patch = vi.spyOn(playback, 'patch')
    const view = render(<Probe playback={playback}>
      <section data-testid="hidden" hidden><span data-testid="target">hidden</span></section>
      <aside data-testid="idle">idle</aside>
    </Probe>)
    await settle()
    const idle = watchTextData(view.getByTestId('idle').firstChild as Text)
    const target = view.getByTestId('target')
    act(() => {
      target.className = 'updated'
      ;(target.firstChild as Text).data = 'updated hidden text'
    })
    await settle()
    expect(target.textContent).toBe('updated hidden text')
    expect(patch).not.toHaveBeenCalled()
    act(() => { view.getByTestId('hidden').hidden = false })
    await settle()
    expect(target.textContent).toBe('updated hidden text')
    expect(idle.reads()).toBe(0)
    idle.restore()
  })

  it('scans hidden append targets locally and snapshots their contents on reveal', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback}>
      <section data-testid="hidden" hidden /><aside data-testid="idle">idle</aside>
    </Probe>)
    await settle()
    const idle = watchTextData(view.getByTestId('idle').firstChild as Text)
    const target = view.getByTestId('hidden')
    act(() => { target.textContent = 'hidden addition' })
    await settle()
    act(() => { target.hidden = false })
    await settle()
    expect(target.textContent).toBe('hidden addition')
    expect(idle.reads()).toBe(0)
    idle.restore()
  })

  it('inherits native control labels during a descendant-only attribute scan', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback}><button><span data-testid="label">Open</span></button></Probe>)
    await settle()
    act(() => {
      const label = view.getByTestId('label')
      label.className = 'changed'
      ;(label.firstChild as Text).data = 'Open more'
    })
    await settle()
    expect(view.getByRole('button').textContent).toBe('Open more')
    expect(frames.size).toBe(0)
  })

  it('ignores transient detached additions without rescanning indexed siblings', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback}><aside data-testid="idle">idle</aside></Probe>)
    await settle()
    const idle = watchTextData(view.getByTestId('idle').firstChild as Text)
    const temporary = document.createElement('span')
    temporary.textContent = 'temporary'
    act(() => {
      view.getByTestId('card:visible').appendChild(temporary)
      temporary.remove()
    })
    await settle()
    expect(idle.reads()).toBe(0)
    idle.restore()
  })

  it('keeps host edits queued during commits between two local scan regions', async () => {
    const playback = engine()
    let duringCommit: (() => void) | undefined
    const view = render(<Probe playback={playback} revealInitial={false} onCommit={() => {
      const edit = duringCommit
      duringCommit = undefined
      edit?.()
    }}>
      <section data-testid="first">a</section><section data-testid="second">b</section>
      <aside data-testid="tail">c</aside>
    </Probe>)
    await settle()
    duringCommit = () => { (view.getByTestId('tail').firstChild as Text).data = 'cXY' }
    act(() => {
      const first = view.getByTestId('first')
      ;(first.firstChild as Text).data = 'aXY'
      first.className = 'updated'
      view.getByTestId('second').className = 'updated'
    })
    await settle()
    await paint(10)
    expect(view.getByTestId('first').textContent).toBe('aXY')
    expect(view.getByTestId('tail').textContent).toBe('cXY')
  })

  it('reuses unrelated Unicode source metadata through appends and local attribute scans', async () => {
    const playback = engine()
    const history = '😀history'.repeat(512)
    const view = render(<Probe playback={playback} revealInitial={false}>
      <aside>{history}</aside><section data-testid="target">active</section>
    </Probe>)
    await settle()
    const iterate = String.prototype[Symbol.iterator]
    let historyWalks = 0
    vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function (this: string) {
      if (this.valueOf() === history) historyWalks++
      return iterate.call(this)
    })
    const addition = document.createElement('em')
    addition.textContent = 'new'
    act(() => view.getByTestId('card:visible').appendChild(addition))
    await settle()
    act(() => { view.getByTestId('target').className = 'updated' })
    await settle()
    expect(historyWalks).toBe(0)
  })

  it('registers previously blank text locally when the host fills it', async () => {
    const playback = engine()
    const view = render(<Probe playback={playback}>
      <section data-testid="target">{' '}</section><aside data-testid="idle">idle</aside>
    </Probe>)
    await settle()
    const idle = watchTextData(view.getByTestId('idle').firstChild as Text)
    act(() => { (view.getByTestId('target').firstChild as Text).data = 'new text' })
    await settle()
    expect(view.getByTestId('target').textContent).toBe('')
    expect(idle.reads()).toBe(0)
    idle.restore()
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

  it('does not rescan live cards when shared follow geometry changes', async () => {
    const playback = engine()
    const upsert = vi.spyOn(playback, 'upsert')
    const view = render(<section data-testid="transcript">
      {Array.from({ length: 5 }, (_, card) => <Probe key={card} playback={playback}
        owner={`live:${card}`} order={[card]}>
        {Array.from({ length: 100 }, (_, text) => <span key={text}>card-{card}-text-{text}</span>)}
      </Probe>)}
    </section>)
    await settle()
    upsert.mockClear()
    const styles = vi.spyOn(window, 'getComputedStyle')
    const transcript = view.getByTestId('transcript')
    for (let frame = 1; frame <= 3; frame++) {
      transcript.style.transform = `translate3d(0, ${frame}px, 0)`
      transcript.style.willChange = 'transform'
      transcript.style.paddingBottom = `${frame}px`
      transcript.style.minHeight = `${frame + 200}px`
      await settle()
    }
    expect(upsert).not.toHaveBeenCalled()
    expect(styles).not.toHaveBeenCalled()
    await paint()
    expect(view.container.querySelector('span')!.textContent).toBe('c')
  })

  it('keeps ancestor class rules that hide descendants observable', async () => {
    const playback = engine()
    const style = document.createElement('style')
    style.textContent = '.fold-native .folded-output { display: none }'
    document.head.appendChild(style)
    const view = render(<section data-testid="ancestor"><Probe playback={playback}>
      <span className="folded-output">abcdef</span><em>tail</em>
    </Probe></section>)
    try {
      await settle()
      view.getByTestId('ancestor').className = 'fold-native'
      await settle()
      expect(view.container.querySelector('span')!.textContent).toBe('abcdef')
      await paint()
      expect(view.container.querySelector('em')!.textContent).toBe('t')
      view.getByTestId('ancestor').className = ''
      await settle()
      expect(view.container.querySelector('span')!.textContent).toBe('abcdef')
    } finally { style.remove() }
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
