import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEllipsisTailProbe } from '../src/client/ellipsisTail.ts'
import { useProgressiveDomText } from '../src/client/useProgressiveDomText.ts'
import { clearToolPresentationLedger, wrapFollowNodeView } from '../src/client/TypewriterToolNodeView.tsx'
import { relayScope, streamRelay } from '../src/client/streamRelay.ts'

const LONG = 'path/'.repeat(600)
let frames: Map<number, FrameRequestCallback>
let time: number
let next: number
let originalRangeRect: PropertyDescriptor | undefined
let originalRangeRects: PropertyDescriptor | undefined
let fixtures: HTMLElement[]

function box(left: number, width: number): DOMRect {
  return { x: left, y: 0, top: 0, bottom: 24, left, right: left + width, width, height: 24,
    toJSON: () => ({}) } as DOMRect
}
function width(element: Element): number {
  return element.hasAttribute('data-clip') ? Number.parseFloat((element as HTMLElement).style.width) || 0 : 0
}
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
  frames = new Map()
  fixtures = []
  time = 0
  next = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = next++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('performance', { now: () => time })
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
    const style = computed(element)
    // jsdom has no layout and does not resolve every inherited text property.
    const clip = element.closest<HTMLElement>('[data-clip]')
    if (style.whiteSpace === '' && clip) style.whiteSpace = clip.style.whiteSpace
    if (style.direction === '' && clip) style.direction = clip.style.direction
    return style
  })
  const rect = Element.prototype.getBoundingClientRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.hasAttribute('data-clip') ? box(200, width(this)) : rect.call(this)
  })
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) { return width(this) })
  vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
    return Math.max(width(this), [...(this.textContent ?? '')].length * 10)
  })
  originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects')
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true,
    value: function (this: Range) { return [this.getBoundingClientRect()] },
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true,
    value: function (this: Range) {
      const node = this.commonAncestorContainer
      if (node.nodeType !== Node.TEXT_NODE) return box(0, 0)
      const text = node as Text
      const offset = Number(text.parentElement?.dataset.offset ?? 0)
      return box(200 + offset, [...text.data].length * 10)
    },
  })
})
afterEach(() => {
  cleanup()
  for (const root of fixtures) root.remove()
  streamRelay.clearAll()
  clearToolPresentationLedger()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalRangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRangeRect)
  else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  if (originalRangeRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRangeRects)
  else Reflect.deleteProperty(Range.prototype, 'getClientRects')
})

function Caption({ text, size = 80, ellipsis = true }: { text: string; size?: number; ellipsis?: boolean }) {
  return <span data-clip data-testid="clip" style={{ display: 'block', whiteSpace: 'nowrap',
    overflowX: 'hidden', textOverflow: ellipsis ? 'ellipsis' : 'clip', direction: 'ltr', width: size }}>
    <span data-testid="caption">{text}</span>
  </span>
}
function Probe({ text = LONG, size = 80, ellipsis = true, following = true, pending = () => {} }: {
  text?: string; size?: number; ellipsis?: boolean; following?: boolean; pending?: (value: boolean) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const speed = useRef(35)
  useProgressiveDomText(root, true, true, speed, undefined, pending)
  return <div ref={root} data-tool="read">
    <div data-chat-call-id="first"><Caption text={text} size={size} ellipsis={ellipsis} /></div>
    {following && <div data-chat-call-id="second" data-testid="second"><span>next tool</span></div>}
  </div>
}
function fixture(prefix = 'abcdefghijkl') {
  const root = document.createElement('div')
  fixtures.push(root)
  document.body.appendChild(root)
  const clip = document.createElement('span')
  clip.dataset.clip = ''
  Object.assign(clip.style, { display: 'block', overflowX: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    direction: 'ltr', width: '80px' })
  const leaf = document.createElement('span')
  const node = document.createTextNode(prefix)
  leaf.appendChild(node)
  clip.appendChild(leaf)
  root.appendChild(clip)
  return { root, clip, leaf, node, probe: createEllipsisTailProbe(root) }
}

const Tool = wrapFollowNodeView(props => <div data-tool="read"><Caption text={props.text as string} /></div>, () => false)
function toolNode(id: string, order: number) {
  return { key: id, kind: 'tool-call', anchorSeq: order,
    data: { turn: 7, step: 2, root: {} },
    location: { kind: 'step', turn: { turn: 7, status: 'open' }, step: { step: 2, status: 'open' } } }
}

describe('ellipsis-hidden Tool tails', () => {
  it('animates the visible prefix, then synchronizes its hidden tail and reveals the next atomic Tool', async () => {
    const view = render(<Probe />)
    expect(view.getByTestId('caption').textContent).toBe('')
    expect(view.getByTestId('second').style.visibility).toBe('hidden')
    await paint(2)
    const partial = view.getByTestId('caption').textContent!
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(LONG.length)
    await paint(18)
    expect(view.getByTestId('caption').textContent).toBe(LONG)
    expect(view.getByTestId('second').style.visibility).not.toBe('hidden')
    expect(view.getByTestId('second').textContent).toBe('next tool')
  })

  it('releases a scoped predecessor lease without waiting for its hidden path tail or business completion', async () => {
    const first = toolNode('first', 10)
    const second = toolNode('second', 20)
    const view = render(<div data-conversation-scroll><div data-chat-flow>
      <article data-chat-flow-key="first"><Tool text={LONG} sessionId="ellipsis" node={first} /></article>
      <article data-chat-flow-key="second"><Tool text="next tool" sessionId="ellipsis" node={second} /></article>
    </div></div>)
    await paint(20)
    expect(view.getAllByTestId('caption')[0]?.textContent).toBe(LONG)
    expect(view.getAllByTestId('caption')[1]?.textContent).toBe('next tool')
    expect(streamRelay.isBlocked(relayScope(second, 'ellipsis'), 'output')).toBe(false)
    // The business call may remain running; only its presentation gate drained.
    expect(streamRelay.hasTool(relayScope(first, 'ellipsis'))).toBe(true)
  })

  it.each([false, true])('does not skip a not-yet-overflowing title (ellipsis=%s)', async ellipsis => {
    const view = render(<Probe text={LONG} size={100000} ellipsis={ellipsis} following={false} />)
    await paint(20)
    expect(view.getByTestId('caption').textContent!.length).toBeGreaterThan(0)
    expect(view.getByTestId('caption').textContent!.length).toBeLessThan(LONG.length)
  })

  it('rechecks current width before retiring a prefix and paces new visible source after widening', async () => {
    const view = render(<Probe following={false} />)
    await paint(4)
    expect(view.getByTestId('caption').textContent!.length).toBeLessThan(LONG.length)
    view.getByTestId('clip').style.width = '100000px'
    await paint(1)
    expect(view.getByTestId('caption').textContent!.length).toBeLessThan(LONG.length)
    view.rerender(<Probe text={LONG} size={80} following={false} />)
    view.getByTestId('clip').style.width = '80px'
    await paint(2)
    expect(view.getByTestId('caption').textContent).toBe(LONG)
    const updated = LONG + ' newly visible text'.repeat(20)
    view.rerender(<Probe text={updated} size={100000} following={false} />)
    await flush()
    await paint(2)
    const shown = view.getByTestId('caption').textContent!
    expect(shown.startsWith(LONG)).toBe(true)
    expect(shown.length).toBeLessThan(updated.length)
  })

  it('keeps a synchronized source on expansion, but does not snapshot new text when ellipsis is removed', async () => {
    const view = render(<Probe following={false} />)
    await paint(10)
    expect(view.getByTestId('caption').textContent).toBe(LONG)
    const updated = LONG + ' readable'.repeat(20)
    view.rerender(<Probe text={updated} ellipsis={false} following={false} />)
    await flush()
    await paint(2)
    expect(view.getByTestId('caption').textContent!.startsWith(LONG)).toBe(true)
    expect(view.getByTestId('caption').textContent!.length).toBeLessThan(updated.length)
  })

  it('uses the current Text endpoint rather than ancestor overflow or a later sibling', () => {
    const { root, clip, node, probe } = fixture('abc')
    clip.appendChild(document.createTextNode('overflowing sibling'.repeat(100)))
    expect(probe(node, LONG)).toBe(false)
    node.data = 'abcdefghijkl'
    expect(probe(node, LONG)).toBe(true)
    root.remove()
  })

  it('rejects wholly offscreen prefixes, zero geometry, external clipping, or a horizontally scrolled line', () => {
    const { root, clip, leaf, node, probe } = fixture()
    leaf.dataset.offset = '200'
    expect(probe(node, LONG)).toBe(false)
    leaf.dataset.offset = '0'
    clip.style.width = '0px'
    expect(probe(node, LONG)).toBe(false)
    clip.style.width = '80px'
    clip.scrollLeft = 5
    expect(probe(node, LONG)).toBe(false)
    clip.scrollLeft = 0
    expect(createEllipsisTailProbe(leaf)(node, LONG)).toBe(false)
    root.remove()
  })

  it.each(['rtl', 'center', 'bidi', 'astral-rtl', 'multiline', 'vertical', 'absolute', 'flex', 'block'] as const)('keeps ambiguous %s text paced', mode => {
    const { root, leaf, node, probe } = fixture()
    let source = LONG
    if (mode === 'rtl') leaf.style.direction = 'rtl'
    if (mode === 'center') leaf.style.textAlign = 'center'
    if (mode === 'bidi') source += '\u202eRTL'
    if (mode === 'astral-rtl') source += '\u{1e900}'
    if (mode === 'multiline') source += '\nvisible next line'
    if (mode === 'vertical') leaf.style.writingMode = 'vertical-rl'
    if (mode === 'absolute') leaf.style.position = 'absolute'
    if (mode === 'flex') leaf.style.display = 'flex'
    if (mode === 'block') leaf.style.display = 'block'
    expect(probe(node, source)).toBe(false)
    root.remove()
  })

  it.each(['visibility', 'opacity'] as const)('does not retire an unpresented prefix hidden by ancestor %s', mode => {
    const { root, node, probe } = fixture()
    if (mode === 'visibility') root.style.visibility = 'hidden'
    else root.style.opacity = '0'
    expect(probe(node, LONG)).toBe(false)
    root.style.visibility = 'visible'
    root.style.opacity = '1'
    expect(probe(node, LONG)).toBe(true)
    root.remove()
  })

  it('adopts a new native source that arrives before MutationObserver instead of reviving the old path', async () => {
    const view = render(<Probe following={false} />)
    await paint(4)
    const node = view.getByTestId('caption').firstChild as Text
    const replacement = 'new visible native source'
    await act(async () => {
      node.data = replacement
      const batch = [...frames.values()]
      frames.clear()
      time += 16
      for (const callback of batch) callback(time)
      expect(node.data.length).toBeGreaterThan(0)
      expect(replacement.startsWith(node.data)).toBe(true)
      expect(node.data).not.toBe(LONG)
    })
    await paint(20)
    expect(node.data).toBe(replacement)
  })

  it('accepts a native source shortened to exactly the controlled prefix before retiring an ellipsis', async () => {
    const view = render(<Probe following={false} />)
    await paint(4)
    const node = view.getByTestId('caption').firstChild as Text
    const shortened = node.data
    expect(shortened.length).toBeGreaterThan(8)
    await act(async () => {
      node.data = shortened
      const batch = [...frames.values()]
      frames.clear()
      time += 16
      for (const callback of batch) callback(time)
    })
    await paint(20)
    expect(node.data).toBe(shortened)
  })

  it('accepts a native clear of the empty controlled prefix before the first animation frame', async () => {
    const pending = vi.fn()
    const view = render(<Probe following={false} pending={pending} />)
    const node = view.getByTestId('caption').firstChild as Text
    expect(node.data).toBe('')
    await act(async () => {
      node.data = ''
      const batch = [...frames.values()]
      frames.clear()
      time += 16
      for (const callback of batch) callback(time)
    })
    await paint(20)
    expect(node.data).toBe('')
    expect(pending).toHaveBeenLastCalledWith(false)
  })

  it('rejects multiple rendered lines, unavailable Range APIs, and failing geometry', () => {
    const { root, node, probe } = fixture()
    const rects = vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      box(200, 100), { ...box(200, 100), top: 30, bottom: 54 },
    ] as unknown as DOMRectList)
    expect(probe(node, LONG)).toBe(false)
    rects.mockRestore()
    const measure = vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() => { throw new Error('unavailable') })
    expect(probe(node, LONG)).toBe(false)
    measure.mockRestore()
    vi.spyOn(document, 'createRange').mockImplementationOnce(() => { throw new Error('unavailable') })
    expect(createEllipsisTailProbe(root)(node, LONG)).toBe(false)
    Reflect.deleteProperty(Range.prototype, 'getClientRects')
    expect(createEllipsisTailProbe(root)(node, LONG)).toBe(false)
  })

  it('matches nested decorative-shimmer path chrome and preserves the original click argument', async () => {
    const openFile = vi.fn()
    function Linked() {
      const root = useRef<HTMLDivElement>(null)
      const speed = useRef(35)
      useProgressiveDomText(root, true, true, speed)
      return <div ref={root} data-tool="read">
        <span style={{ display: 'inline-grid' }} data-text-shimmer>
          <span style={{ display: 'flex' }}>读取<button data-clip style={{ display: 'inline-block', width: 80, overflowX: 'hidden',
            whiteSpace: 'nowrap', textOverflow: 'ellipsis', direction: 'ltr', textAlign: 'left' }}
            onClick={() => openFile(LONG)}><span data-testid="caption">{LONG}</span></button></span>
          <span aria-hidden="true">{LONG}</span>
        </span>
      </div>
    }
    const view = render(<Linked />)
    await paint(2)
    expect(view.getByTestId('caption').textContent!.length).toBeLessThan(LONG.length)
    await paint(20)
    expect(view.getByTestId('caption').textContent).toBe(LONG)
    fireEvent.click(view.getByRole('button'))
    expect(openFile).toHaveBeenCalledExactlyOnceWith(LONG)
  })

  it('keeps code-point content intact when synchronizing an emoji/CJK path', async () => {
    const text = '目录/😀/'.repeat(400)
    const view = render(<Probe text={text} following={false} />)
    await paint(12)
    expect(view.getByTestId('caption').textContent).toBe(text)
  })
})
