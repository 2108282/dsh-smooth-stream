import { createElement, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

const CHAT_NODE_SLOT = 'conversation.chat.node'

/** Decorate components without stealing their owned child Slots or injected services. */
export function installRendererAdapter(
  ctx: Context,
  decorate: (key: string, component: unknown) => unknown,
): () => void {
  const originals = new Map<StoredEntry, { original: unknown; wrapped: unknown }>()
  const listeners = new Set<() => void>()
  let revision = 0
  let disposed = false
  let lastSlotVersion = ctx.slots.getVersion(CHAT_NODE_SLOT)
  const subscribe = (listener: () => void): (() => void) => {
    if (disposed) return () => {}
    listeners.add(listener)
    const off = ctx.slots.subscribe(CHAT_NODE_SLOT, listener)
    return () => { off(); listeners.delete(listener) }
  }
  const getSnapshot = (): string => {
    // React may render our retained wrapper after Cordis has deactivated ctx.
    // Disposal must never resolve a service through that inactive context.
    if (!disposed) lastSlotVersion = ctx.slots.getVersion(CHAT_NODE_SLOT)
    return `${lastSlotVersion}:${revision}:${disposed}`
  }
  const apply = (): void => {
    if (disposed) return
    for (const entry of ctx.slots.entries(CHAT_NODE_SLOT)) {
      const key = entry.options.key
      if (key === undefined) continue
      if (originals.get(entry)?.wrapped === entry.component) continue
      const original = entry.component
      const decorated = decorate(key, original)
      if (decorated === original) continue
      const wrapped = function RendererAdapterEntry(props: Record<string, unknown>) {
        useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
        return createElement(
          (disposed ? original : decorated) as ComponentType<Record<string, unknown>>,
          props,
        )
      }
      originals.set(entry, { original, wrapped })
      entry.component = wrapped
    }
  }
  const off = ctx.slots.subscribe(CHAT_NODE_SLOT, apply)
  apply()
  return () => {
    if (disposed) return
    disposed = true
    revision += 1
    for (const listener of [...listeners]) listener()
    off()
    for (const [entry, record] of originals) {
      if (entry.component === record.wrapped) entry.component = record.original
    }
    originals.clear()
  }
}
