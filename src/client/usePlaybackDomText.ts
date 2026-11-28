import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { PlaybackSegment, SessionPlayback } from './sessionPlayback.ts'

export interface PlaybackDomTextOptions {
  playback: SessionPlayback
  owner: string
  order: readonly number[]
  animate: boolean
  enabled: boolean
  /** When false, adopt the first DOM snapshot while still animating later live changes. */
  revealInitial?: boolean
  /** Runs after synchronous child registration, not after the text drains. */
  onReady?: (() => void) | undefined
  onPendingChange?: ((pending: boolean) => void) | undefined
  onCommit?: (() => void) | undefined
}

interface TextSource {
  id: string
  full: string
  baseline?: string
}

interface DomLedger {
  paths: Map<string, TextSource>
  hiddenPaths: Set<string>
  nextId: number
}

interface TextBinding {
  source: TextSource
  written: string
  visible: boolean
}

interface DomBridge {
  root: HTMLElement
  playback: SessionPlayback
  owner: string
  scan: () => void
  dispose: () => void
}

// Only source strings and structural identities survive a renderer remount.
// Neither an old Text node nor an independent animation clock is retained.
const ledgers = new WeakMap<SessionPlayback, Map<string, DomLedger>>()
const LEDGER_LIMIT = 512
const EXCLUDED = '[aria-hidden="true"],[aria-live],[contenteditable]:not([contenteditable="false"]),script,style,textarea,input,select,svg,math,canvas'
const CONTROLS = 'button,[role="button"],summary'
const OBSERVED_ATTRIBUTES = ['hidden', 'style', 'class', 'open', 'data-open', 'aria-hidden', 'aria-live', 'contenteditable', 'aria-expanded']

function getLedger(playback: SessionPlayback, owner: string): DomLedger {
  let owners = ledgers.get(playback)
  if (owners === undefined) {
    owners = new Map()
    ledgers.set(playback, owners)
  }
  let ledger = owners.get(owner)
  if (ledger === undefined) {
    ledger = { paths: new Map(), hiddenPaths: new Set(), nextId: 0 }
    owners.set(owner, ledger)
    if (owners.size > LEDGER_LIMIT) owners.delete(owners.keys().next().value!)
  }
  return ledger
}

function baselineLength(source: TextSource): number | undefined {
  if (source.baseline === undefined) return undefined
  const previous = [...source.baseline]
  const current = [...source.full]
  let length = 0
  while (length < previous.length && previous[length] === current[length]) length++
  return length
}

function hidden(element: Element): boolean {
  if (element.hasAttribute('hidden')) return true
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return style?.display === 'none' || style?.visibility === 'hidden'
    || style?.visibility === 'collapse' || style?.contentVisibility === 'hidden'
}

function hiddenOutside(root: HTMLElement): boolean {
  for (let element = root.parentElement; element !== null; element = element.parentElement) {
    if (hidden(element) || element.matches(EXCLUDED)) return true
    if (element.localName === 'details' && !element.hasAttribute('open')) {
      const summary = element.querySelector(':scope > summary')
      if (summary === null || !summary.contains(root)) return true
    }
  }
  return false
}

/** DisclosureRow mounts its detail body on expansion rather than hiding it. */
function openedBody(node: Node): boolean {
  if (!(node instanceof Element) || node.closest('[data-tool]') === null) return false
  if (node.matches('[data-tool-body],[data-disclosure-body],[class*="_bodyWrap"]')) return true
  return node.id !== '' && [...node.parentElement?.querySelectorAll('[aria-controls][aria-expanded="true"]') ?? []]
    .some(control => control.getAttribute('aria-controls')?.split(/\s+/).includes(node.id))
}

function createBridge(root: HTMLElement, playback: SessionPlayback, owner: string, options: () => PlaybackDomTextOptions): DomBridge {
  const ledger = getLedger(playback, owner)
  const bindings = new Map<Text, TextBinding>()
  const internalWrites = new WeakMap<Text, { before: string; after: string }[]>()
  const snapshots = new Set<Node>()
  let ordered: Text[] = []
  let stopped = false
  let initial = true
  let ready = false
  let pending: boolean | undefined
  let observer: MutationObserver | undefined

  const write = (node: Text, binding: TextBinding, value: string): boolean => {
    const changed = node.data !== value
    if (changed) {
      if (observer !== undefined) {
        let writes = internalWrites.get(node)
        if (writes === undefined) internalWrites.set(node, writes = [])
        writes.push({ before: node.data, after: value })
      }
      node.data = value
    }
    binding.written = value
    return changed
  }

  const consume = (mutations: readonly MutationRecord[]): boolean => {
    let changed = false
    // MutationRecord has no newValue. Reconstruct it from the following oldValue
    // before comparing writes, so host edits and our own writes in one batch do
    // not turn a displayed prefix into the new source of truth.
    const nextValues = new Map<Text, string>()
    const changes: { node: Text; before: string; after: string }[] = []
    for (let index = mutations.length - 1; index >= 0; index--) {
      const mutation = mutations[index]!
      if (mutation.type !== 'characterData') continue
      const node = mutation.target as Text
      changes.push({ node, before: mutation.oldValue ?? '', after: nextValues.get(node) ?? node.data })
      nextValues.set(node, mutation.oldValue ?? '')
    }
    for (const change of changes.reverse()) {
      const writes = internalWrites.get(change.node)
      const expected = writes?.[0]
      if (expected?.before === change.before && expected.after === change.after) {
        writes!.shift()
        if (writes!.length === 0) internalWrites.delete(change.node)
      } else {
        const binding = bindings.get(change.node)
        if (binding !== undefined) binding.source.full = change.after
        changed = true
      }
    }
    for (const node of nextValues.keys()) {
      const binding = bindings.get(node)
      if (binding !== undefined) binding.written = node.data
    }
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') continue
      changed = true
      if (mutation.type === 'childList') {
        for (const added of mutation.addedNodes) if (openedBody(added)) snapshots.add(added)
      } else if (mutation.attributeName === 'open' && (mutation.target as Element).hasAttribute('open')) {
        snapshots.add(mutation.target)
      } else if (mutation.attributeName === 'data-open' && (mutation.target as Element).hasAttribute('data-open')) {
        // The shipped DisclosureRow mounts body children beside its header;
        // it has no aria-controls or tool-specific body wrapper. Snapshot only
        // the expansion commit so later appended output still uses the queue.
        const disclosure = mutation.target as Element
        const header = disclosure.querySelector(':scope > [data-disclosure-header]')
        if (header !== null) {
          for (const child of disclosure.childNodes) if (child !== header) snapshots.add(child)
        }
      } else if (mutation.attributeName === 'aria-expanded' && (mutation.target as Element).getAttribute('aria-expanded') === 'true') {
        const control = mutation.target as Element
        const ids = control.getAttribute('aria-controls')?.split(/\s+/) ?? []
        for (const id of ids) {
          const body = root.ownerDocument.getElementById(id)
          if (body !== null && root.contains(body)) snapshots.add(body)
        }
      }
    }
    return changed
  }

  const drain = (): boolean => consume(observer?.takeRecords() ?? [])

  const present = (adopted?: ReadonlySet<Text>): void => {
    let committed = false
    let nextPending = false
    for (const node of ordered) {
      const binding = bindings.get(node)!
      if (!binding.visible) continue
      const display = playback.read(binding.source.id)
      const completeBaseline = baselineLength(binding.source) === [...binding.source.full].length
      if (!completeBaseline && (display.pending || display.text !== binding.source.full)) nextPending = true
      if (adopted?.has(node)) continue
      // A host commit can land before MutationObserver delivery. Never overwrite
      // that full source with an old playback prefix while the commit is pending.
      if (node.data !== binding.written) continue
      if (write(node, binding, display.text)) committed = true
    }
    if (committed) options().onCommit?.()
    nextPending &&= options().animate
    if (nextPending !== pending) {
      pending = nextPending
      options().onPendingChange?.(nextPending)
    }
  }

  const scan = (): void => {
    if (stopped) return
    drain()
    const current = options()
    const nextHidden = new Set<string>()
    const nextOrdered: Text[] = []
    const adopted = new Set<Text>()
    const claimed = new Set<string>()
    const segments: PlaybackSegment[] = []
    for (const [node, binding] of bindings) {
      binding.visible = false
      if (root.contains(node)) claimed.add(binding.source.id)
    }

    const visit = (element: Element, path: string, snapshot: boolean, control: boolean): void => {
      if (element.matches(EXCLUDED) || hidden(element)) {
        nextHidden.add(path)
        return
      }
      snapshot ||= ledger.hiddenPaths.has(path) || snapshots.has(element)
      control ||= element.matches(CONTROLS)
      let index = 0
      const summary = element.localName === 'details' && !element.hasAttribute('open')
        ? element.querySelector(':scope > summary') : undefined
      for (const child of element.childNodes) {
        if (child.nodeType !== Node.ELEMENT_NODE && child.nodeType !== Node.TEXT_NODE) continue
        const childPath = `${path}/${index++}:${child.nodeType === Node.TEXT_NODE ? 'text' : (child as Element).localName}`
        if (summary !== undefined && child !== summary) {
          nextHidden.add(childPath)
          continue
        }
        if (child.nodeType === Node.ELEMENT_NODE) {
          visit(child as Element, childPath, snapshot, control)
          continue
        }
        const node = child as Text
        let binding = bindings.get(node)
        if (binding === undefined) {
          if (node.data.trim() === '') continue
          let source = ledger.paths.get(childPath)
          if (source === undefined || claimed.has(source.id)) {
            const structuralId = `${owner}:text:${childPath}`
            source = { id: claimed.has(structuralId) ? `${structuralId}:${++ledger.nextId}` : structuralId, full: node.data }
          } else source.full = node.data
          claimed.add(source.id)
          binding = { source, written: node.data, visible: true }
          bindings.set(node, binding)
        } else if (node.data !== binding.written) {
          binding.source.full = node.data
          binding.written = node.data
        }
        ledger.paths.set(childPath, binding.source)
        binding.visible = true
        if (snapshot || snapshots.has(node) || ledger.hiddenPaths.has(childPath) || control || !current.animate || binding.source.full.trim() === '') {
          binding.source.baseline = binding.source.full
          adopted.add(node)
          write(node, binding, binding.source.full)
        }
        const baseline = baselineLength(binding.source)
        segments.push({
          id: binding.source.id,
          order: [...current.order, nextOrdered.length],
          text: binding.source.full,
          sealed: true,
          ...(baseline === undefined ? {} : { baselineChars: baseline }),
        })
        nextOrdered.push(node)
      }
    }

    if (hiddenOutside(root)) nextHidden.add('root')
    else visit(root, 'root', (initial && current.revealInitial === false) || ledger.hiddenPaths.has('root'), false)
    for (const [node, binding] of bindings) {
      if (binding.visible) continue
      if (node.data !== binding.written) binding.source.full = node.data
      // Hidden text is native snapshot content; reopening it must not replay a
      // previously queued suffix, and it consumes no visible character budget.
      if (root.contains(node)) binding.source.baseline = binding.source.full
      write(node, binding, binding.source.full)
      if (!root.contains(node)) bindings.delete(node)
    }
    ordered = nextOrdered
    ledger.hiddenPaths = nextHidden
    snapshots.clear()
    initial = false
    playback.upsert(owner, segments, current.animate)
    present(adopted)
    if (!ready) {
      ready = true
      current.onReady?.()
    }
  }

  observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(mutations => {
    if (!stopped && consume(mutations)) scan()
  })
  observer?.observe(root, {
    subtree: true, childList: true, characterData: true, characterDataOldValue: true,
    attributes: true, attributeOldValue: true, attributeFilter: OBSERVED_ATTRIBUTES,
  })
  const ancestorObserver = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(() => { scan() })
  for (let ancestor = root.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    ancestorObserver?.observe(ancestor, { attributes: true, attributeFilter: OBSERVED_ATTRIBUTES })
  }
  const unsubscribe = playback.subscribe(() => {
    if (stopped) return
    if (drain()) scan()
    else present()
  })

  return {
    root, playback, owner, scan,
    dispose: () => {
      if (stopped) return
      drain()
      stopped = true
      unsubscribe()
      observer?.disconnect()
      ancestorObserver?.disconnect()
      for (const [node, binding] of bindings) {
        if (node.data === binding.written) node.data = binding.source.full
      }
      bindings.clear()
      ordered = []
      if (pending) options().onPendingChange?.(false)
      playback.remove(owner)
    },
  }
}

/** Adapt opaque native renderer Text nodes to the session's one shared queue. */
export function usePlaybackDomText(rootRef: RefObject<HTMLElement | null>, options: PlaybackDomTextOptions): void {
  const latest = useRef(options)
  latest.current = options
  const bridge = useRef<DomBridge | null>(null)
  useLayoutEffect(() => {
    const root = rootRef.current
    const { playback, owner, enabled } = latest.current
    if (bridge.current !== null && (!enabled || !latest.current.animate || root !== bridge.current.root
      || playback !== bridge.current.playback || owner !== bridge.current.owner)) {
      bridge.current.dispose()
      bridge.current = null
    }
    if (root === null || !enabled || !latest.current.animate) {
      latest.current.onPendingChange?.(false)
      latest.current.onReady?.()
      return
    }
    bridge.current ??= createBridge(root, playback, owner, () => latest.current)
    bridge.current.scan()
  })
  useLayoutEffect(() => () => {
    bridge.current?.dispose()
    bridge.current = null
  }, [])
}
