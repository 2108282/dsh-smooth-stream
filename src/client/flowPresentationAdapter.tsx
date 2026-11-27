import { createElement, useMemo, useSyncExternalStore, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatFlowSlotProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { SessionPlaybackFlow } from './sessionPlaybackReact.tsx'
import type { StreamSmoothingPreset } from './useSmoothStreamContent.ts'
import type { StreamSettings } from '../settings.ts'

const CHAT_FLOW_SLOT = 'conversation.chat.flow'
const CHAT_NODE_SLOT = 'conversation.chat.node'

export interface SettingsSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): StreamSettings
  takeoverEnabled?(): boolean
}

/** Keep the official Flow entry, options, and owned child slots intact. */
export function installFlowPresentationAdapter(
  ctx: Context,
  settings: SettingsSource,
  canManageRenderer: (key: string, component: unknown) => boolean,
  preset: StreamSmoothingPreset = 'balanced',
): () => void {
  const originals = new Map<StoredEntry, { original: unknown; wrapped: unknown }>()
  const listeners = new Set<() => void>()
  let revision = 0
  let disposed = false
  let lastFlowVersion = ctx.slots.getVersion(CHAT_FLOW_SLOT)
  let lastNodeVersion = ctx.slots.getVersion(CHAT_NODE_SLOT)
  const subscribe = (listener: () => void): (() => void) => {
    if (disposed) return () => {}
    listeners.add(listener)
    const offFlow = ctx.slots.subscribe(CHAT_FLOW_SLOT, listener)
    const offNodes = ctx.slots.subscribe(CHAT_NODE_SLOT, listener)
    return () => { offFlow(); offNodes(); listeners.delete(listener) }
  }
  const getSnapshot = (): string => {
    // Retained React wrappers must not resolve services after context disposal.
    if (!disposed) {
      lastFlowVersion = ctx.slots.getVersion(CHAT_FLOW_SLOT)
      lastNodeVersion = ctx.slots.getVersion(CHAT_NODE_SLOT)
    }
    return `${lastFlowVersion}:${lastNodeVersion}:${revision}:${disposed}`
  }
  const apply = (): void => {
    if (disposed) return
    for (const entry of ctx.slots.entries(CHAT_FLOW_SLOT)) {
      if (originals.get(entry)?.wrapped === entry.component) continue
      const original = entry.component
      if (typeof original !== 'function'
        && (original === null || typeof original !== 'object' || !('$$typeof' in original))) continue
      const Inner = original as ComponentType<ChatFlowSlotProps>
      const wrapped = function SmoothStreamFlowEntry(props: ChatFlowSlotProps) {
        const version = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
        const managedNodeKinds = useMemo(() => new Set(disposed ? [] : ctx.slots.entries(CHAT_NODE_SLOT)
          .filter(nodeEntry => nodeEntry.options.key !== undefined
            && canManageRenderer(nodeEntry.options.key, nodeEntry.component))
          .map(nodeEntry => String(nodeEntry.options.key))), [version])
        return disposed ? createElement(Inner, props)
          : createElement(SessionPlaybackFlow, { Inner, props, settings, managedNodeKinds, preset })
      }
      originals.set(entry, { original, wrapped })
      entry.component = wrapped
    }
  }
  // Subscribe before the initial pass so later official Flow registrations join.
  const off = ctx.slots.subscribe(CHAT_FLOW_SLOT, apply)
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
