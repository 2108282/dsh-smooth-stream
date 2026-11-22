/**
 * Progressive text reveal for opaque Agent renderers.
 *
 * Slot renderers own arbitrary React trees, so the generic integration cannot
 * clone or classify their business components. This hook leaves that tree and
 * all of its event handlers in place, and only paces visible Text node data
 * while the row belongs to the live Agent turn. No clip, mask, overlay, or
 * duplicate accessibility tree is introduced.
 */

import { useLayoutEffect, useRef, type RefObject } from 'react'
import { computeAdaptiveQueueStep } from './useSmoothStreamContent.ts'
import type { BackgroundRecovery } from '../settings.ts'
import { recoveryBudget, useBackgroundRecovery, type RecoveryPosition } from './backgroundRecovery.ts'
import { debugRuntime } from './debugRuntime.ts'

interface TextRevealRecord {
  chars: readonly string[]
  full: string
  shown: number
}

/** Last presented text per root, retained across follow lifecycle flips. */
const ledgerByRoot = new WeakMap<HTMLElement, Map<Text, TextRevealRecord>>()

const SKIP_TEXT_SELECTOR = [
  '[aria-hidden="true"]',
  '[aria-live]',
  '[contenteditable="true"]',
  'script',
  'style',
  'textarea',
].join(',')

function excludedElement(element: Element): boolean {
  return element.matches(SKIP_TEXT_SELECTOR)
}

/** DSH ToolRow mounts its DisclosureRow body on open; nested ToolDetails also
 * use native details. Neither an aria-hidden icon nor a collapsed summary is
 * evidence that the whole Tool call should stop updating. */
const cssHidden = new WeakSet<Element>()
const measuredClasses = new WeakMap<Element, string>()

function hiddenElement(element: Element): boolean {
  if (element.hasAttribute('hidden')) return true
  if (element instanceof HTMLElement && (element.style.display === 'none'
    || element.style.contentVisibility === 'hidden'
    || (!element.hasAttribute('data-chat-call-id') && element.style.visibility === 'hidden'))) return true
  const classes = element.getAttribute('class') ?? ''
  if (classes === '' && measuredClasses.has(element)) {
    measuredClasses.delete(element)
    cssHidden.delete(element)
  } else if (classes !== '' && measuredClasses.get(element) !== classes) {
    measuredClasses.set(element, classes)
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.contentVisibility === 'hidden') cssHidden.add(element)
    else cssHidden.delete(element)
  }
  if (cssHidden.has(element)) return true
  const parent = element.parentElement
  return parent instanceof HTMLDetailsElement && !parent.open
    && element !== parent.querySelector(':scope > summary')
}

function hiddenOutside(root: HTMLElement): boolean {
  let element = root.parentElement
  while (element !== null) {
    if (hiddenElement(element)) return true
    element = element.parentElement
  }
  return false
}

function visibleWithin(node: Node, root: HTMLElement): boolean {
  if (node.nodeType === Node.TEXT_NODE && node.parentElement instanceof HTMLDetailsElement && !node.parentElement.open) return false
  let element = node instanceof Element ? node : node.parentElement
  while (element !== null) {
    if (excludedElement(element) || hiddenElement(element)) return false
    if (element === root) return !hiddenOutside(root)
    element = element.parentElement
  }
  return false
}

function revealable(node: Text, root: HTMLElement): boolean {
  return node.data.trim() !== '' && visibleWithin(node, root)
}

function commonPrefix(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

/**
 * Pace text inside a renderer whose React component is intentionally opaque.
 * Initial content is revealed only for a genuinely new row; later mutations
 * stay paced until `enabled` becomes false, at which point the full renderer
 * content is restored synchronously before paint.
 */
export function useProgressiveDomText(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  revealInitial: boolean,
  speedCpsRef: { current: number },
  onSettled?: (() => void) | undefined,
  onPendingChange?: ((pending: boolean) => void) | undefined,
  paused = false,
  backgroundRecovery: BackgroundRecovery = 'catch-up',
  recoveryKey?: string,
  recoveryPosition?: RecoveryPosition,
  observeChanges = enabled,
): void {
  const callbacks = useRef({ onSettled, onPendingChange })
  callbacks.current = { onSettled, onPendingChange }
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const resume = useRef<(() => void) | null>(null)
  const suspend = useRef<(() => void) | null>(null)
  const recovery = useBackgroundRecovery(backgroundRecovery, () => suspend.current?.(), () => resume.current?.(),
    recoveryKey, recoveryPosition, false, enabled || observeChanges)
  const recoveryRef = useRef(recovery)
  recoveryRef.current = recovery
  useLayoutEffect(() => { if (!paused) resume.current?.() }, [paused])
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null || typeof document === 'undefined') return

    let records = ledgerByRoot.get(root)
    if (!enabled && records === undefined && !observeChanges) {
      callbacks.current.onPendingChange?.(false)
      return
    }
    if (records === undefined) {
      records = new Map<Text, TextRevealRecord>()
      ledgerByRoot.set(root, records)
    }

    const callRows = new Set<HTMLElement>()
    let orderedCalls: HTMLElement[] = []
    let callOrderDirty = true
    const registerCall = (element: HTMLElement): void => {
      if (callRows.has(element)) return
      callRows.add(element)
      callOrderDirty = true
    }
    const forEachText = (from: Node, callback: (text: Text) => void): void => {
      if (!visibleWithin(from, root)) return
      if (from instanceof HTMLElement && from.hasAttribute('data-chat-call-id')) registerCall(from)
      if (from.nodeType === Node.TEXT_NODE) {
        callback(from as Text)
        return
      }
      // SHOW_ELEMENT is essential: rejecting an element prunes its complete
      // hidden subtree before any of its Text nodes are visited.
      const walker = document.createTreeWalker(from, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: node => {
          if (!(node instanceof Element)) return NodeFilter.FILTER_ACCEPT
          if (excludedElement(node) || hiddenElement(node)) return NodeFilter.FILTER_REJECT
          if (node instanceof HTMLElement && node.hasAttribute('data-chat-call-id')) registerCall(node)
          return NodeFilter.FILTER_SKIP
        },
      })
      let current = walker.nextNode()
      while (current !== null) {
        callback(current as Text)
        current = walker.nextNode()
      }
    }

    const settle = (text: Text): void => {
      if (!revealable(text, root)) return
      const chars = [...text.data]
      records.set(text, { chars, full: text.data, shown: chars.length })
    }

    const snapshotVisible = (): void => {
      const current = new Set<Text>()
      forEachText(root, (text) => {
        if (!revealable(text, root)) return
        current.add(text)
        settle(text)
      })
      for (const text of records.keys()) {
        if (!current.has(text)) records.delete(text)
      }
    }

    if (!enabled) {
      callbacks.current.onPendingChange?.(false)
      snapshotVisible()
      // Terminal/static rows need no observer. An explicitly live caller can
      // retain local snapshot bookkeeping without rescanning the entire root.
      if (!observeChanges) return
      const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(mutations => {
        for (const mutation of mutations) {
          if (!visibleWithin(mutation.target, root)) continue
          if (mutation.type === 'characterData') settle(mutation.target as Text)
          else for (const added of mutation.addedNodes) forEachText(added, settle)
        }
      })
      observer?.observe(root, { childList: true, characterData: true, subtree: true })
      return () => { observer?.disconnect() }
    }

    const pending = new Set<Text>()
    // Atomic Tool rows share this root's single budget. Keep later call chrome
    // hidden as well, so icons/running effects cannot all appear before text.
    const concealed = new Map<HTMLElement, { visibility: string; priority: string }>()
    const syncCallVisibility = (): void => {
      if (callRows.size === 0) return
      if (callOrderDirty) {
        // Structural mutations can move an existing call without changing its
        // identity. Rebuild this small visible-call order only on those commits.
        orderedCalls = [...callRows].sort((left, right) => left === right ? 0
          : (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ? -1 : 1)
        callOrderDirty = false
      }
      const pendingCalls = new Set<Element>()
      for (const text of pending) {
        const call = text.parentElement?.closest('[data-chat-call-id]')
        if (call) pendingCalls.add(call)
      }
      let waitingForEarlier = false
      for (const call of orderedCalls) {
        if (!root.contains(call) || !visibleWithin(call, root)) {
          const previous = concealed.get(call)
          if (previous !== undefined) {
            if (previous.visibility) call.style.setProperty('visibility', previous.visibility, previous.priority)
            else call.style.removeProperty('visibility')
            concealed.delete(call)
          }
          callRows.delete(call)
          callOrderDirty = true
          continue
        }
        const hasPending = pendingCalls.has(call)
        const hide = pausedRef.current || waitingForEarlier
        if (hide && !concealed.has(call)) {
          concealed.set(call, { visibility: call.style.getPropertyValue('visibility'), priority: call.style.getPropertyPriority('visibility') })
          call.style.setProperty('visibility', 'hidden')
        } else if (!hide && concealed.has(call)) {
          const previous = concealed.get(call)!
          if (previous.visibility) call.style.setProperty('visibility', previous.visibility, previous.priority)
          else call.style.removeProperty('visibility')
          concealed.delete(call)
        }
        if (hasPending) waitingForEarlier = true
      }
    }
    const internalWrites = new WeakMap<Text, string>()
    let rafId = 0
    let lastFrame: number | null = null
    let debt = 0
    let stopped = false
    let announcedSettled = false
    const streamId = `dom-${Math.random().toString(36).slice(2)}`

    const announceSettled = (): void => {
      lastFrame = null
      debt = 0
      speedCpsRef.current = 35
      debugRuntime.reportStream(streamId, null)
      recoveryRef.current.finish()
      if (announcedSettled) return
      announcedSettled = true
      callbacks.current.onPendingChange?.(false)
      callbacks.current.onSettled?.()
    }

    const write = (node: Text, value: string): void => {
      if (node.data === value) return
      internalWrites.set(node, value)
      node.data = value
    }

    const enqueue = (node: Text, full: string, preserve: TextRevealRecord | undefined): void => {
      if (!revealable(node, root)) {
        // React can replace a paused source with whitespace or move it into a
        // non-revealable surface. Never replay the previous registered value.
        pending.delete(node)
        records.delete(node)
        internalWrites.delete(node)
        return
      }
      const chars = [...full]
      const preserved = preserve === undefined
        ? 0
        : Math.min(preserve.shown, commonPrefix(preserve.chars, chars))
      const record = { chars, full, shown: preserved }
      records.set(node, record)
      if (preserved < chars.length) {
        pending.add(node)
        announcedSettled = false
        callbacks.current.onPendingChange?.(true)
      } else {
        pending.delete(node)
      }
      write(node, chars.slice(0, preserved).join(''))
    }

    const visit = (from: Node, reveal: boolean): void => {
      forEachText(from, (text) => {
        if (!revealable(text, root)) return
        if (reveal) {
          const record = records.get(text)
          // A moved Text node can still hold our revealed prefix, not new source.
          if (record !== undefined && text.data === record.chars.slice(0, record.shown).join('')) return
          enqueue(text, text.data, record)
          return
        }
        settle(text)
      })
    }

    const forget = (from: Node): void => {
      for (const [text] of records) {
        if (!from.contains(text) || root.contains(text)) continue
        records.delete(text)
        pending.delete(text)
      }
    }

    const scheduleFrame = (): void => {
      syncCallVisibility()
      if (stopped || pausedRef.current || recoveryRef.current.hidden() || pending.size === 0 || rafId !== 0) return
      rafId = requestAnimationFrame(frame)
    }

    const frame = (now: number): void => {
      rafId = 0
      if (stopped || recoveryRef.current.hidden()) { lastFrame = null; return }
      if (pending.size === 0) {
        announceSettled()
        return
      }
      if (pausedRef.current) { lastFrame = null; return }
      announcedSettled = false
      if (lastFrame === null) {
        lastFrame = now
        scheduleFrame()
        return
      }
      const elapsed = Math.max(0, now - lastFrame)
      const playback = recoveryRef.current
      playback.detectGap(elapsed)
      const catchingUp = playback.recovering() && playback.mode() === 'catch-up'

      const orderedPending: Array<{ node: Text; record: TextRevealRecord }> = []
      let backlog = 0
      for (const node of pending) {
        const record = records.get(node)
        if (record === undefined || !node.isConnected || !visibleWithin(node, root)) {
          // A collapse can land before MutationObserver delivery. Stop spending
          // the visible reveal budget on that node; the observer restores its
          // source once, never one character per frame.
          if (record !== undefined && node.isConnected && root.contains(node)) {
            const controlled = record.chars.slice(0, record.shown).join('')
            if (node.data === controlled) write(node, record.full)
          }
          pending.delete(node)
          records.delete(node)
          continue
        }
        orderedPending.push({ node, record })
        backlog += record.chars.length - record.shown
      }
      // Earlier nodes can re-enter the queue, and nodes can move while queued.
      orderedPending.sort((left, right) => (
        (left.node.compareDocumentPosition(right.node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ? -1 : 1
      ))
      if (playback.recovering() && playback.mode() === 'latest') {
        for (const { node, record } of orderedPending) {
          write(node, record.full)
          records.set(node, { ...record, shown: record.chars.length })
        }
        pending.clear()
        syncCallVisibility()
        announceSettled()
        playback.finish()
        return
      }
      lastFrame = now
      const tuning = debugRuntime.activeTuning()
      const step = computeAdaptiveQueueStep(backlog, Math.min(elapsed, 32), debt, 1, tuning)
      const budget = catchingUp ? recoveryBudget(backlog, elapsed, debt, tuning) : { chars: step.revealChars, debt: step.debt }
      debt = budget.debt
      speedCpsRef.current = catchingUp ? budget.chars * 1000 / Math.max(1, elapsed) : step.speedCps
      let remaining = budget.chars
      for (const { node, record } of orderedPending) {
        if (remaining <= 0) break
        const amount = Math.min(remaining, record.chars.length - record.shown)
        const shown = record.shown + amount
        const next = { ...record, shown }
        records.set(node, next)
        write(node, next.chars.slice(0, shown).join(''))
        remaining -= amount
        if (shown >= next.chars.length) pending.delete(node)
      }
      let targetChars = 0
      let displayedChars = 0
      let nextBacklog = 0
      for (const [node, record] of records) {
        if (!node.isConnected) {
          records.delete(node)
          pending.delete(node)
          continue
        }
        targetChars += record.chars.length
        displayedChars += record.shown
        if (pending.has(node)) nextBacklog += record.chars.length - record.shown
      }
      debugRuntime.reportStream(streamId, {
        backlog: nextBacklog,
        speedCps: speedCpsRef.current,
        targetChars,
        displayedChars,
        active: pending.size > 0,
      })
      syncCallVisibility()
      if (pending.size === 0) announceSettled()
      else scheduleFrame()
    }

    resume.current = () => {
      lastFrame = null
      debt = 0
      if (pending.size === 0 && rafId === 0 && !stopped && !recoveryRef.current.hidden()) rafId = requestAnimationFrame(frame)
      else scheduleFrame()
    }
    suspend.current = () => { cancelAnimationFrame(rafId); rafId = 0; lastFrame = null; debt = 0 }
    visit(root, revealInitial)

    const releaseSubtree = (from: Node): void => {
      // Work from the small controlled ledger, never walk a collapsed body.
      for (const [node, record] of records) {
        if (!from.contains(node)) continue
        const controlled = record.chars.slice(0, record.shown).join('')
        if (node.data === controlled) write(node, record.full)
        records.delete(node)
        pending.delete(node)
      }
    }
    const isOpenedBody = (node: Node): boolean => node instanceof Element
      && node.closest('[data-tool]') !== null
      && (node.matches('[data-tool-body], [data-disclosure-body], [class*="_bodyWrap"]')
        || (node.id !== '' && [...node.parentElement?.querySelectorAll('[data-disclosure-header] [aria-controls][aria-expanded="true"]') ?? []]
          .some(control => control.getAttribute('aria-controls')?.split(/\s+/).includes(node.id))))

    const observer = !observeChanges || typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((mutations) => {
          // Attribute reveals are snapshots, even when child insertion arrived
          // in the same React commit. Dedupe roots so nested mutations don't
          // repeatedly scan the same newly visible details.
          const snapshots = new Set<Node>()
          for (const mutation of mutations) {
            if (mutation.type !== 'attributes') continue
            const target = mutation.target as Element
            const attribute = mutation.attributeName
            // A mutation inside an already hidden ancestor cannot reveal this
            // body. Its ancestor's own visibility mutation will snapshot it.
            if (target !== root && target.parentElement !== null && !visibleWithin(target.parentElement, root)) continue
            const previouslyHidden = cssHidden.has(target)
              || (attribute === 'hidden' && mutation.oldValue !== null)
              || (attribute === 'style' && (/(?:display\s*:\s*none|content-visibility\s*:\s*hidden)/i.test(mutation.oldValue ?? '')
                || (!target.hasAttribute('data-chat-call-id') && /(?:^|;)\s*visibility\s*:\s*hidden/i.test(mutation.oldValue ?? ''))))
            if (attribute === 'style' || attribute === 'class') {
              // Only the changed element is measured, once per observer batch;
              // reveal frames never read computed style or scan hidden bodies.
              const style = getComputedStyle(target)
              if (style.display === 'none' || style.contentVisibility === 'hidden') cssHidden.add(target)
              else cssHidden.delete(target)
            }
            const nowHidden = hiddenElement(target)
            if (attribute !== 'open' && previouslyHidden === nowHidden) continue
            releaseSubtree(target)
            if (visibleWithin(target, root)) snapshots.add(target)
          }
          for (const mutation of mutations) {
            if (mutation.type === 'attributes' || !visibleWithin(mutation.target, root)) continue
            if ([...snapshots].some(snapshot => snapshot.contains(mutation.target))) continue
            if (mutation.type === 'characterData') {
              const node = mutation.target as Text
              const expected = internalWrites.get(node)
              if (expected === node.data) {
                internalWrites.delete(node)
                continue
              }
              enqueue(node, node.data, records.get(node))
              continue
            }
            callOrderDirty = true
            for (const removed of mutation.removedNodes) forget(removed)
            for (const added of mutation.addedNodes) {
              if (isOpenedBody(added)) snapshots.add(added)
              else visit(added, true)
            }
          }
          for (const snapshot of snapshots) {
            if ([...snapshots].some(other => other !== snapshot && other.contains(snapshot))) continue
            visit(snapshot, false)
          }
          syncCallVisibility()
          if (pending.size === 0) announceSettled()
          else scheduleFrame()
        })
    let outsideHidden = hiddenOutside(root)
    const ancestorObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
      const hidden = hiddenOutside(root)
      if (hidden === outsideHidden) return
      outsideHidden = hidden
      // A folded Turn can hide the whole Tool wrapper outside our owned root.
      // Restore its controlled text once; reopening is a snapshot, not replay.
      if (hidden) releaseSubtree(root)
      else visit(root, false)
      syncCallVisibility()
      if (pending.size === 0) announceSettled()
      else scheduleFrame()
    })
    for (let ancestor = root.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      ancestorObserver?.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] })
    }
    observer?.observe(root, {
      childList: true, characterData: true, subtree: true, attributes: true,
      attributeFilter: ['hidden', 'style', 'class', 'open'], attributeOldValue: true,
    })
    if (pending.size === 0) announceSettled()
    else scheduleFrame()

    return () => {
      stopped = true
      resume.current = null
      suspend.current = null
      callbacks.current.onPendingChange?.(false)
      cancelAnimationFrame(rafId)
      observer?.disconnect()
      ancestorObserver?.disconnect()
      for (const [node, record] of records) {
        const controlled = record.chars.slice(0, record.shown).join('')
        // React may have committed a terminal replacement in the same mutation
        // phase that disables this hook. Never overwrite that newer renderer
        // value with the previous controlled source during layout cleanup.
        if (node.isConnected && node.data === controlled) {
          write(node, record.full)
        }
      }
      pending.clear()
      for (const [call, previous] of concealed) {
        if (previous.visibility) call.style.setProperty('visibility', previous.visibility, previous.priority)
        else call.style.removeProperty('visibility')
      }
      concealed.clear()
      speedCpsRef.current = 35
      debugRuntime.reportStream(streamId, null)
    }
  }, [enabled, observeChanges, revealInitial, rootRef, speedCpsRef])
}
