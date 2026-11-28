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
  completeBaseline: boolean
}

interface ConsumedMutations {
  readonly needsScan: boolean
  readonly sourceNodes: readonly Text[]
  readonly appendNodes: readonly { target: Element; node: Node }[]
  readonly removedNodes: readonly { target: Element; node: Node }[]
  readonly scanRegions: readonly { target: Element; removedNodes: readonly Node[] }[]
}

interface DomBridge {
  root: HTMLElement
  playback: SessionPlayback
  owner: string
  scan: () => void
  refresh: () => void
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

function underControl(node: Text, root: HTMLElement): boolean {
  for (let element = node.parentElement; element !== null; element = element.parentElement) {
    if (element.matches(CONTROLS)) return true
    if (element === root) break
  }
  return false
}

function sameOrder(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
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

function structuralPath(root: HTMLElement, node: Node): string | undefined {
  const parts: string[] = []
  let currentNode: Node = node
  while (currentNode !== root) {
    const parent: Node | null = currentNode.parentNode
    if (parent === null) return undefined
    let ordinal = 0
    let found = false
    for (const child of parent.childNodes) {
      if (child.nodeType !== Node.ELEMENT_NODE && child.nodeType !== Node.TEXT_NODE) continue
      if (child === currentNode) {
        parts.push(`${ordinal}:${child.nodeType === Node.TEXT_NODE ? 'text' : (child as Element).localName}`)
        found = true
        break
      }
      ordinal++
    }
    if (!found) return undefined
    currentNode = parent
  }
  parts.push('root')
  return parts.reverse().join('/')
}

function createBridge(root: HTMLElement, playback: SessionPlayback, owner: string, options: () => PlaybackDomTextOptions): DomBridge {
  const ledger = getLedger(playback, owner)
  const bindings = new Map<Text, TextBinding>()
  const internalWrites = new WeakMap<Text, { before: string; after: string }[]>()
  const snapshots = new Set<Node>()
  const hiddenNodes = new Map<Node, string>()
  let ordered: Text[] = []
  let segments: PlaybackSegment[] = []
  const segmentIndices = new Map<string, number>()
  const bindingsBySource = new Map<string, Set<Text>>()
  const pendingSources = new Set<string>()
  let stopped = false
  let initial = true
  let ready = false
  let pending: boolean | undefined
  let lastOrder = [...options().order]
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

  const sameSegment = (left: PlaybackSegment, right: PlaybackSegment): boolean =>
    left.id === right.id && sameOrder(left.order, right.order) && left.text === right.text
    && left.sealed === right.sealed && left.hidden === right.hidden
    && left.awaitPresentation === right.awaitPresentation && left.generation === right.generation
    && left.baselineChars === right.baselineChars

  const commitSegments = (next: PlaybackSegment[], current: PlaybackDomTextOptions, full: boolean): void => {
    const previous = segments
    segments = next
    if (full) {
      playback.upsert(owner, next, current.animate)
      return
    }
    const previousById = new Map(previous.map(segment => [segment.id, segment]))
    const nextIds = new Set(next.map(segment => segment.id))
    const upserts = next.filter(segment => {
      const old = previousById.get(segment.id)
      return old === undefined || !sameSegment(old, segment)
    })
    const removals = previous.filter(segment => !nextIds.has(segment.id)).map(segment => segment.id)
    if (upserts.length > 0 || removals.length > 0) playback.patch(owner, upserts, removals, current.animate)
  }

  const segmentFor = (node: Text, index: number, current: PlaybackDomTextOptions, changed: boolean): PlaybackSegment => {
    const binding = bindings.get(node)!
    const order = [...current.order, index]
    const previous = segments[segmentIndices.get(binding.source.id) ?? -1]
    // Structure edits may renumber cached sources, but only affected text needs
    // Unicode baseline work; an appended leaf must not reprocess every string.
    if (!changed && previous !== undefined) {
      return sameOrder(previous.order, order) ? previous : { ...previous, order }
    }
    const baseline = baselineLength(binding.source)
    binding.completeBaseline = baseline === [...binding.source.full].length
    return {
      id: binding.source.id,
      order,
      text: binding.source.full,
      sealed: true,
      ...(baseline === undefined ? {} : { baselineChars: baseline }),
    }
  }

  const refreshPaths = (hiddenOnly = false): void => {
    // Sibling insertions change structural addresses, not source identity. Cache
    // sibling ordinals once per parent; never reread text or computed styles.
    const paths = new Map<Node, string>([[root, 'root']])
    const pathOf = (node: Node): string | undefined => {
      const known = paths.get(node)
      if (known !== undefined) return known
      const parent = node.parentNode
      if (parent === null) return undefined
      const prefix = pathOf(parent)
      if (prefix === undefined) return undefined
      let index = 0
      for (const child of parent.childNodes) {
        if (child.nodeType !== Node.ELEMENT_NODE && child.nodeType !== Node.TEXT_NODE) continue
        paths.set(child, `${prefix}/${index++}:${child.nodeType === Node.TEXT_NODE ? 'text' : (child as Element).localName}`)
      }
      return paths.get(node)
    }
    if (!hiddenOnly) {
      const live = new Map<string, TextSource>()
      for (const [node, binding] of bindings) {
        const path = pathOf(node)
        if (path !== undefined) live.set(path, binding.source)
      }
      const sources = new Set(live.values())
      for (const [path, source] of ledger.paths) if (sources.has(source)) ledger.paths.delete(path)
      for (const [path, source] of live) ledger.paths.set(path, source)
    }
    const nextHidden = new Set<string>()
    for (const node of hiddenNodes.keys()) {
      const path = pathOf(node)
      if (path === undefined) hiddenNodes.delete(node)
      else {
        hiddenNodes.set(node, path)
        nextHidden.add(path)
      }
    }
    ledger.hiddenPaths = nextHidden
  }

  const consume = (mutations: readonly MutationRecord[]): ConsumedMutations => {
    let needsScan = false
    const sourceNodes = new Set<Text>()
    const appendNodes: { target: Element; node: Node }[] = []
    const removedNodes: { target: Element; node: Node }[] = []
    const scanRegions = new Map<Element, Set<Node>>()
    const addScanRegion = (target: Element, removedNodes: Iterable<Node> = []): void => {
      let removed = scanRegions.get(target)
      if (removed === undefined) scanRegions.set(target, removed = new Set())
      for (const node of removedNodes) removed.add(node)
    }
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
        if (binding !== undefined) {
          binding.source.full = change.after
          sourceNodes.add(change.node)
        } else {
          // A character mutation from an unindexed node means the host changed
          // structure before the observer could deliver its childList record.
          if (change.node.parentElement !== null) addScanRegion(change.node.parentElement)
        }
      }
    }
    for (const node of nextValues.keys()) {
      const binding = bindings.get(node)
      if (binding !== undefined) binding.written = node.data
    }
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') continue
      if (mutation.type === 'childList') {
        const target = mutation.target instanceof Element ? mutation.target : undefined
        if (target === undefined) needsScan = true
        else {
          for (const node of mutation.addedNodes) {
            appendNodes.push({ target, node })
            if (openedBody(node)) snapshots.add(node)
          }
          for (const node of mutation.removedNodes) removedNodes.push({ target, node })
        }
        continue
      }
      if (mutation.type === 'attributes' && mutation.target instanceof Element) addScanRegion(mutation.target)
      else needsScan = true
      if (mutation.attributeName === 'open' && (mutation.target as Element).hasAttribute('open')) {
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
    return {
      needsScan,
      sourceNodes: [...sourceNodes],
      appendNodes,
      removedNodes,
      scanRegions: [...scanRegions].map(([target, removedNodes]) => ({ target, removedNodes: [...removedNodes] })),
    }
  }

  const drain = (): ConsumedMutations => consume(observer?.takeRecords() ?? [])

  const updateChangedSources = (nodes: readonly Text[]): void => {
    const changedIds = new Set<string>()
    const changedSegments: PlaybackSegment[] = []
    for (const node of nodes) {
      const binding = bindings.get(node)
      if (binding === undefined || !binding.visible) continue
      const index = segmentIndices.get(binding.source.id)
      if (index === undefined) continue
      if (underControl(node, root)) binding.source.baseline = binding.source.full
      const length = [...binding.source.full].length
      const baseline = baselineLength(binding.source)
      binding.completeBaseline = baseline === length
      const previous = segments[index]
      if (previous === undefined) continue
      const next: PlaybackSegment = { ...previous, text: binding.source.full }
      if (baseline === undefined) delete next.baselineChars
      else next.baselineChars = baseline
      segments[index] = next
      changedSegments.push(next)
      changedIds.add(binding.source.id)
    }
    if (changedIds.size === 0) return
    // Patch only sources whose host text changed; unrelated owners and nodes are
    // not reprocessed on every native renderer commit.
    const current = options()
    playback.updateSegments(owner, changedSegments, current.animate)
    // A host can rewrite the exact same full source after the bridge truncated it.
    // Restore its current prefix synchronously even when the engine state is equal.
    present([...changedIds], undefined, true)
  }

  // Local scans inherit the same visibility, control and expansion context as
  // an initial walk from the root, without revisiting their siblings.
  const contextOf = (node: Node): { hiddenRoot?: Element; control: boolean; snapshot: boolean } => {
    let control = false
    let snapshot = ledger.hiddenPaths.has('root')
    for (let element = node.parentElement; element !== null; element = element.parentElement) {
      if (element.matches(EXCLUDED) || hidden(element)) return { hiddenRoot: element, control, snapshot }
      control ||= element.matches(CONTROLS)
      const path = structuralPath(root, element)
      snapshot ||= snapshots.has(element) || (path !== undefined && ledger.hiddenPaths.has(path))
      if (element.localName === 'details' && !element.hasAttribute('open')) {
        const summary = element.querySelector(':scope > summary')
        if (summary === null || !summary.contains(node)) return { hiddenRoot: element, control, snapshot }
      }
      if (element === root) break
    }
    return { control, snapshot }
  }

  const updateAddedSubtrees = (
    appends: readonly { target: Element; node: Node }[],
    removals: readonly { target: Element; node: Node }[],
  ): boolean => {
    if (appends.length === 0 && removals.length === 0) return true
    if (hiddenOutside(root)) return false
    const current = options()
    const claimed = new Set([...bindings.values()].map(binding => binding.source.id))
    const addedNodes: Text[] = []
    const removedText = new Set<Text>()
    const removedIds = new Set<string>()
    const adopted = new Set<Text>()
    const addedIds = new Set<string>()
    const collectRemoved = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node as Text
        removedText.add(text)
        const binding = bindings.get(text)
        if (binding === undefined || root.contains(text)) return
        binding.visible = false
        if (text.data !== binding.written) binding.source.full = text.data
        write(text, binding, binding.source.full)
        bindings.delete(text)
        claimed.delete(binding.source.id)
        removedIds.add(binding.source.id)
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      for (const child of node.childNodes) collectRemoved(child)
    }
    for (const removal of removals) collectRemoved(removal.node)

    const collect = (node: Node, path: string, inheritedControl: boolean, inheritedSnapshot: boolean): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node as Text
        let binding = bindings.get(text)
        if (binding === undefined && text.data.trim() === '') return
        if (binding === undefined) {
          let source = ledger.paths.get(path)
          if (source === undefined || claimed.has(source.id)) {
            const structuralId = `${owner}:text:${path}`
            source = { id: claimed.has(structuralId) ? `${structuralId}:${++ledger.nextId}` : structuralId, full: text.data }
          } else source.full = text.data
          claimed.add(source.id)
          binding = {
            source, written: text.data, visible: true,
            completeBaseline: baselineLength(source) === [...source.full].length,
          }
          bindings.set(text, binding)
        } else if (text.data !== binding.written) {
          binding.source.full = text.data
          binding.written = text.data
        }
        binding.completeBaseline = baselineLength(binding.source) === [...binding.source.full].length
        binding.visible = true
        ledger.paths.set(path, binding.source)
        if (inheritedSnapshot || snapshots.has(text) || ledger.hiddenPaths.has(path) || inheritedControl || !current.animate || binding.source.full.trim() === '') {
          binding.source.baseline = binding.source.full
          adopted.add(text)
          write(text, binding, binding.source.full)
        }
        addedNodes.push(text)
        addedIds.add(binding.source.id)
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const element = node as Element
      if (element.matches(EXCLUDED) || hidden(element)) {
        ledger.hiddenPaths.add(path)
        hiddenNodes.set(element, path)
        return
      }
      const control = inheritedControl || element.matches(CONTROLS)
      const snapshot = inheritedSnapshot || snapshots.has(element) || ledger.hiddenPaths.has(path)
      const summary = element.localName === 'details' && !element.hasAttribute('open')
        ? element.querySelector(':scope > summary') : undefined
      let ordinal = 0
      for (const child of element.childNodes) {
        if (child.nodeType !== Node.ELEMENT_NODE && child.nodeType !== Node.TEXT_NODE) continue
        const childPath = `${path}/${ordinal++}:${child.nodeType === Node.TEXT_NODE ? 'text' : (child as Element).localName}`
        if (summary !== undefined && child !== summary) {
          ledger.hiddenPaths.add(childPath)
          hiddenNodes.set(child, childPath)
          continue
        }
        collect(child, childPath, control, snapshot)
      }
    }

    for (const append of appends) {
      if (!root.contains(append.node)) continue
      const context = contextOf(append.node)
      if (context.hiddenRoot !== undefined) return false
      const nodePath = structuralPath(root, append.node)
      if (nodePath === undefined) return false
      collect(append.node, nodePath, context.control, context.snapshot || snapshots.has(append.node))
    }
    for (const append of appends) {
      for (const node of snapshots) if (node === append.node || append.node.contains(node)) snapshots.delete(node)
    }
    if (addedNodes.length === 0 && removedText.size === 0) return true

    const nextOrdered = [...new Set([...ordered.filter(node => !removedText.has(node) || root.contains(node)), ...addedNodes])]
    nextOrdered.sort((left, right) => {
      if (left === right) return 0
      const position = left.compareDocumentPosition(right)
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })
    const nextSegments = nextOrdered.map((node, index) =>
      segmentFor(node, index, current, addedIds.has(bindings.get(node)!.source.id)))
    ordered = nextOrdered
    segmentIndices.clear()
    bindingsBySource.clear()
    for (const [index, node] of ordered.entries()) {
      const binding = bindings.get(node)
      if (binding === undefined) continue
      segmentIndices.set(binding.source.id, index)
      const nodes = bindingsBySource.get(binding.source.id) ?? new Set<Text>()
      nodes.add(node)
      bindingsBySource.set(binding.source.id, nodes)
    }
    lastOrder = [...current.order]
    commitSegments(nextSegments, current, false)
    present([...new Set([...addedIds, ...removedIds])], adopted, true)
    return true
  }

  const present = (changedIds?: readonly string[], adopted?: ReadonlySet<Text>, currentState = false): void => {
    let committed = false
    const current = options()
    if (changedIds === undefined) pendingSources.clear()
    const nodes = changedIds === undefined
      ? ordered
      : changedIds.flatMap(id => [...(bindingsBySource.get(id) ?? [])])
    const uniqueNodes = new Set(nodes)
    if (changedIds !== undefined) {
      for (const id of changedIds) if (!bindingsBySource.has(id)) pendingSources.delete(id)
    }
    for (const node of uniqueNodes) {
      const binding = bindings.get(node)
      if (binding === undefined || !binding.visible) continue
      const display = currentState ? playback.readCurrent(binding.source.id) : playback.read(binding.source.id)
      const pendingSource = !binding.completeBaseline && (display.pending || display.text !== binding.source.full)
      if (pendingSource) pendingSources.add(binding.source.id)
      else pendingSources.delete(binding.source.id)
      if (adopted?.has(node)) continue
      // A host commit can land before MutationObserver delivery. Never overwrite
      // that full source with an old playback prefix while the commit is pending.
      if (node.data !== binding.written) continue
      if (write(node, binding, display.text)) committed = true
    }
    if (committed) current.onCommit?.()
    const nextPending = current.animate && pendingSources.size > 0
    if (nextPending !== pending) {
      pending = nextPending
      current.onPendingChange?.(nextPending)
    }
  }

  const scan = (scope?: Element, removedNodes: readonly Node[] = []): void => {
    if (stopped) return
    const current = options()
    lastOrder = [...current.order]
    const partial = scope !== undefined && scope !== root
    if (partial && (!root.contains(scope) || hiddenOutside(root))) {
      scan()
      return
    }
    const context = partial ? contextOf(scope!) : { control: false, snapshot: false }
    if (context.hiddenRoot !== undefined) {
      scan(context.hiddenRoot, removedNodes)
      return
    }
    const scanRoot = partial ? scope : root
    const scanPath = partial ? structuralPath(root, scope!) : 'root'
    if (scanPath === undefined) {
      scan()
      return
    }
    const affectedNodes = new Set<Text>()
    const affectedIds = new Set<string>()
    const collectTextNodes = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        affectedNodes.add(node as Text)
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      for (const child of node.childNodes) collectTextNodes(child)
    }
    if (partial) {
      collectTextNodes(scanRoot)
      for (const node of removedNodes) collectTextNodes(node)
    }
    if (partial) {
      for (const node of hiddenNodes.keys()) {
        if (node === scanRoot || scanRoot!.contains(node)
          || removedNodes.some(removed => removed === node || removed.contains(node))) hiddenNodes.delete(node)
      }
    } else hiddenNodes.clear()
    const nextHidden = new Set<string>()
    const nextOrdered: Text[] = []
    const adopted = new Set<Text>()
    const claimed = new Set([...bindings.values()].map(binding => binding.source.id))
    const nextSegments: PlaybackSegment[] = []
    if (partial) {
      for (const node of affectedNodes) {
        const binding = bindings.get(node)
        if (binding === undefined) continue
        binding.visible = false
        if (!root.contains(node)) claimed.delete(binding.source.id)
        affectedIds.add(binding.source.id)
      }
    } else {
      claimed.clear()
      for (const [node, binding] of bindings) {
        binding.visible = false
        if (root.contains(node)) claimed.add(binding.source.id)
      }
    }

    const visit = (element: Element, path: string, snapshot: boolean, control: boolean): void => {
      if (element.matches(EXCLUDED) || hidden(element)) {
        nextHidden.add(path)
        hiddenNodes.set(element, path)
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
          hiddenNodes.set(child, childPath)
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
          binding = {
            source, written: node.data, visible: true,
            completeBaseline: baselineLength(source) === [...source.full].length,
          }
          bindings.set(node, binding)
        } else if (node.data !== binding.written) {
          binding.source.full = node.data
          binding.written = node.data
        }
        binding.completeBaseline = baselineLength(binding.source) === [...binding.source.full].length
        ledger.paths.set(childPath, binding.source)
        binding.visible = true
        if (snapshot || snapshots.has(node) || ledger.hiddenPaths.has(childPath) || control || !current.animate || binding.source.full.trim() === '') {
          binding.source.baseline = binding.source.full
          adopted.add(node)
          write(node, binding, binding.source.full)
        }
        const baseline = baselineLength(binding.source)
        binding.completeBaseline = baseline === [...binding.source.full].length
        nextSegments.push({
          id: binding.source.id,
          order: [...current.order, nextOrdered.length],
          text: binding.source.full,
          sealed: true,
          ...(baseline === undefined ? {} : { baselineChars: baseline }),
        })
        nextOrdered.push(node)
      }
    }

    if (hiddenOutside(root)) {
      if (partial) {
        scan()
        return
      }
      nextHidden.add('root')
      hiddenNodes.set(root, 'root')
    } else {
      visit(scanRoot!, scanPath, context.snapshot || (!partial && initial && current.revealInitial === false), context.control)
    }
    const staleNodes: Iterable<Text> = partial ? affectedNodes : bindings.keys()
    for (const node of staleNodes) {
      const binding = bindings.get(node)
      if (binding === undefined || binding.visible) continue
      if (node.data !== binding.written) binding.source.full = node.data
      // Hidden text is native snapshot content; reopening it must not replay a
      // previously queued suffix, and it consumes no visible character budget.
      if (root.contains(node)) binding.source.baseline = binding.source.full
      write(node, binding, binding.source.full)
      if (!root.contains(node)) bindings.delete(node)
    }
    if (partial) {
      ordered = [...ordered.filter(node => !affectedNodes.has(node)), ...nextOrdered]
      ordered.sort((left, right) => {
        if (left === right) return 0
        const position = left.compareDocumentPosition(right)
        return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      })
      for (const node of nextOrdered) {
        const binding = bindings.get(node)
        if (binding !== undefined) affectedIds.add(binding.source.id)
      }
    } else {
      ordered = nextOrdered
    }
    const nextSegmentsForOwner = partial ? ordered.map((node, index) =>
      segmentFor(node, index, current, affectedIds.has(bindings.get(node)!.source.id))) : nextSegments
    segmentIndices.clear()
    bindingsBySource.clear()
    for (const [index, node] of ordered.entries()) {
      const binding = bindings.get(node)
      if (binding === undefined) continue
      segmentIndices.set(binding.source.id, index)
      const nodes = bindingsBySource.get(binding.source.id) ?? new Set<Text>()
      nodes.add(node)
      bindingsBySource.set(binding.source.id, nodes)
    }
    if (partial) {
      const prefix = `${scanPath}/`
      for (const path of ledger.hiddenPaths) if (path === scanPath || path.startsWith(prefix)) ledger.hiddenPaths.delete(path)
      for (const path of nextHidden) ledger.hiddenPaths.add(path)
      for (const node of snapshots) {
        if (node === scanRoot || scanRoot!.contains(node) || affectedNodes.has(node as Text)) snapshots.delete(node)
      }
    } else {
      pendingSources.clear()
      ledger.hiddenPaths = nextHidden
      snapshots.clear()
    }
    if (!partial) refreshPaths()
    initial = false
    commitSegments(nextSegmentsForOwner, current, !partial)
    present(partial ? [...affectedIds] : undefined, adopted, true)
    if (!ready) {
      ready = true
      current.onReady?.()
    }
  }

  const updateOrder = (): void => {
    const current = options()
    if (sameOrder(lastOrder, current.order)) return
    lastOrder = [...current.order]
    const next = segments.map((segment, index) => ({ ...segment, order: [...lastOrder, index] }))
    commitSegments(next, current, false)
  }

  const processMutations = (result: ConsumedMutations): void => {
    if (stopped) return
    // Move visibility markers before new nodes can occupy their former paths.
    if (result.appendNodes.length > 0 || result.removedNodes.length > 0) refreshPaths(true)
    if (result.needsScan) {
      scan()
      return
    }
    const regions = new Map<Element, Set<Node>>()
    const scanRegions = [...result.scanRegions]
    for (const append of result.appendNodes) {
      if (!root.contains(append.node)) continue
      const context = contextOf(append.node)
      if (context.hiddenRoot !== undefined) scanRegions.push({ target: context.hiddenRoot, removedNodes: [] })
    }
    for (const region of scanRegions) {
      let ancestor = [...regions.keys()].find(target => target.contains(region.target))
      if (ancestor === undefined) {
        const descendants = [...regions.keys()].filter(target => region.target.contains(target))
        if (descendants.length > 0) {
          ancestor = region.target
          const removed = new Set<Node>(region.removedNodes)
          for (const descendant of descendants) {
            for (const node of regions.get(descendant)!) removed.add(node)
            regions.delete(descendant)
          }
          regions.set(ancestor, removed)
        } else {
          regions.set(region.target, new Set(region.removedNodes))
          continue
        }
      }
      for (const node of region.removedNodes) regions.get(ancestor)!.add(node)
    }
    const changedOutsideRegions = result.sourceNodes.filter(node =>
      ![...regions.keys()].some(target => target.contains(node)))
    if (changedOutsideRegions.length > 0) updateChangedSources(changedOutsideRegions)
    const uncoveredAppends = result.appendNodes.filter(append =>
      ![...regions.keys()].some(target => target.contains(append.node)))
    const uncoveredRemovals: { target: Element; node: Node }[] = []
    for (const removal of result.removedNodes) {
      const region = [...regions.keys()].find(target => target === removal.target || target.contains(removal.target))
      if (region === undefined) uncoveredRemovals.push(removal)
      else regions.get(region)!.add(removal.node)
    }
    if ((uncoveredAppends.length > 0 || uncoveredRemovals.length > 0)
      && !updateAddedSubtrees(uncoveredAppends, uncoveredRemovals)) {
      scan()
      return
    }
    for (const [target, removedNodes] of regions) scan(target, [...removedNodes])
    if (result.appendNodes.length > 0 || result.removedNodes.length > 0) refreshPaths()
    updateOrder()
  }

  const refresh = (): void => {
    if (stopped) return
    if (observer === undefined) scan()
    else processMutations(drain())
  }

  observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(mutations => {
    processMutations(consume(mutations))
  })
  observer?.observe(root, {
    subtree: true, childList: true, characterData: true, characterDataOldValue: true,
    attributes: true, attributeOldValue: true, attributeFilter: OBSERVED_ATTRIBUTES,
  })
  const ancestorObserver = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(() => {
    // A full visibility refresh covers pending host changes too. Local scans
    // leave newly queued records for the next delivery rather than dropping them.
    drain()
    scan()
  })
  for (let ancestor = root.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    ancestorObserver?.observe(ancestor, { attributes: true, attributeFilter: OBSERVED_ATTRIBUTES })
  }
  const unsubscribe = playback.subscribeChanges(changedIds => {
    if (stopped) return
    processMutations(drain())
    if (changedIds.length > 0) present(changedIds)
  })

  return {
    root, playback, owner, scan, refresh,
    dispose: () => {
      if (stopped) return
      processMutations(drain())
      stopped = true
      unsubscribe()
      observer?.disconnect()
      ancestorObserver?.disconnect()
      for (const [node, binding] of bindings) {
        if (node.data === binding.written) node.data = binding.source.full
      }
      bindings.clear()
      hiddenNodes.clear()
      ordered = []
      segments = []
      segmentIndices.clear()
      bindingsBySource.clear()
      pendingSources.clear()
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
    if (bridge.current === null) {
      const created = createBridge(root, playback, owner, () => latest.current)
      bridge.current = created
      created.scan()
    } else {
      bridge.current.refresh()
    }
  })
  useLayoutEffect(() => () => {
    bridge.current?.dispose()
    bridge.current = null
  }, [])
}
