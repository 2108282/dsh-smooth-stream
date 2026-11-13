import { createElement, useSyncExternalStore, type ComponentType } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the connection and settings slot declarations.
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { NativeAssistantNodeView } from './NativeAssistantNodeView.tsx'
import { installRendererAdapter } from './rendererAdapter.ts'
import { installConversationPipeline } from './conversationPipeline.ts'
import { wrapFollowNodeView, type FollowWrapProps } from './TypewriterToolNodeView.tsx'
import { SmoothStreamCard } from './SmoothStreamCard.tsx'
import { SmoothStreamCardController } from './smooth-stream-card-controller.ts'
import { createSmoothStreamSettingsApi } from './smooth-stream-settings-api.ts'
import { DebugPanel } from './DebugPanel.tsx'
import { debugRuntime } from './debugRuntime.ts'
import { NS as SETTINGS_NS, en, zh } from './locales.ts'
import { DEFAULT_STREAM_CONFIG, STREAM_BOOT_GLOBAL, type StreamConfig } from '../config.ts'
import { DEFAULT_STREAM_SETTINGS, type StreamSettings } from '../settings.ts'

/**
 * Cordis services required by the browser half. Only `slots` is load-bearing
 * for the stream itself; locale and Connection power the configuration card
 * and are wired through `ctx.inject` below so a deployment without them still
 * streams with defaults.
 */
export const inject = ['slots']

type AssistantProps = ChatNodeViewProps<'assistant-step'>

const STREAM_MODES: readonly string[] = ['typewriter', 'teleprompter']
const STREAM_PRESETS: readonly string[] = ['realtime', 'balanced', 'silky']

/**
 * The assistant renderer owns its own character queue and conversation
 * follower, so wrapping it again would create two scroll owners. Human input
 * stays immediate; every Agent-owned output renderer goes through the same
 * generic follow boundary. This is deliberately keyed by the owner that
 * provides the renderer, not by individual tool names, so new Context,
 * Command, and Tool rows are covered automatically.
 */
const SKIP_WRAP = new Set(['user', 'steering', 'command-input', 'turn-process', 'turn-tail'])

/** React function/class or an exotic component such as memo/forwardRef/lazy. */
function isWrappableComponent(value: unknown): value is ComponentType<FollowWrapProps> {
  return typeof value === 'function'
    || (value !== null && typeof value === 'object' && '$$typeof' in value)
}

/**
 * Read the Host-bridged boot config. The inline script is produced by this
 * plugin's Host half from a schema-validated value, so only the structural
 * guarantees that could break between the two halves are re-checked: the
 * global is absent when the client runs without its Host entry (defaults
 * apply), and any present-but-malformed value fails loudly instead of
 * rendering a half-configured view.
 * @returns The resolved configuration for the assistant node view.
 */
function readBootConfig(): StreamConfig {
  const raw = (globalThis as Record<string, unknown>)[STREAM_BOOT_GLOBAL]
  if (raw === undefined) {
    console.info('[dsh-smooth-stream] no host config bridge; using defaults')
    return DEFAULT_STREAM_CONFIG
  }
  if (
    typeof raw !== 'object' || raw === null
    || !STREAM_MODES.includes((raw as StreamConfig).mode)
    || !STREAM_PRESETS.includes((raw as StreamConfig).preset)
    || typeof (raw as StreamConfig).revealCharsPerSec !== 'number'
    || typeof (raw as StreamConfig).scrollSpeedPxPerSec !== 'number'
    || typeof (raw as StreamConfig).maxScrollSpeedPxPerSec !== 'number'
  ) {
    throw new Error(`[dsh-smooth-stream] malformed ${STREAM_BOOT_GLOBAL} boot global: ${JSON.stringify(raw)}`)
  }
  return raw as StreamConfig
}

/**
 * A live settings cell shared by the renderer lifecycle and React views. It
 * starts on the shared defaults and follows the plugin-owned controller once
 * the optional settings services arrive.
 */
class SettingsCell {
  private readonly listeners = new Set<() => void>()
  private card: SmoothStreamCardController | undefined
  private value: StreamSettings = (() => {
    const val = { ...DEFAULT_STREAM_SETTINGS }
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('dsh-smooth-stream:settings') : null
      if (saved) Object.assign(val, JSON.parse(saved))
    } catch {}
    return val
  })()
  private pending = false

  /** Re-point the cell at the plugin-owned settings controller. */
  attach(card: SmoothStreamCardController): () => void {
    this.card = card
    this.refresh()
    const unsubscribe = card.subscribe(() => { this.refresh() })
    return () => {
      unsubscribe()
      if (this.card !== card) return
      this.card = undefined
      this.refresh()
    }
  }

  private read(): StreamSettings {
    const snapshot = this.card?.getSnapshot()
    if (snapshot === undefined || snapshot.status !== 'ready') return this.value
    return this.card?.values() ?? this.value
  }

  private refresh(): void {
    const next = this.read()
    const pending = this.card?.getSnapshot().status === 'loading'
    if (
      pending === this.pending
      && next.enabled === this.value.enabled
      && next.controlScroll === this.value.controlScroll
      && next.motionPreference === this.value.motionPreference
      && next.thinkAutoExpand === this.value.thinkAutoExpand
      && next.logarithmicFade === this.value.logarithmicFade
      && next.fastFold === this.value.fastFold
      && next.fastPipeline === this.value.fastPipeline
      && next.keepStreamOnToolCall === this.value.keepStreamOnToolCall
      && next.debugEnabled === this.value.debugEnabled
      && next.debugTuning === this.value.debugTuning
    ) return
    this.pending = pending
    this.value = next
    for (const listener of this.listeners) listener()
  }

  /** Always respect the user's enabled preference immediately. */
  takeoverEnabled(): boolean {
    return !this.pending && this.value.enabled
  }

  readonly getSnapshot = (): StreamSettings => this.value

  readonly subscribe = (listener: () => void): () => void => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

const FAST_FOLD_STYLE_ID = 'smooth-stream-fast-fold-style'

function ensureFastFoldStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(FAST_FOLD_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = FAST_FOLD_STYLE_ID
  style.textContent = `
    /* Only committed hidden process rows detach; never interrupt the Host fold clock. */
    html[data-smooth-stream-fast-fold="true"] [data-chat-flow] [data-turn-process-hidden][hidden] {
      display: none !important;
    }
    /* Preserve popovers and wide Markdown: paint containment would clip them. */
    html[data-smooth-stream-fast-fold="true"] [data-smooth-stream-settled="true"] {
      contain: layout style;
    }
  `
  document.head.appendChild(style)
}

function syncFastFold(enabled: boolean): void {
  if (typeof document === 'undefined') return
  ensureFastFoldStyles()
  if (enabled) {
    document.documentElement.setAttribute('data-smooth-stream-fast-fold', 'true')
  } else {
    document.documentElement.removeAttribute('data-smooth-stream-fast-fold')
  }
}

/** Install only the feature-detected, instance-local publishing optimization. */
function healDshConversationPipeline(ctx: ClientContext, settings: SettingsCell): void {
  ctx.inject(['uiConversation'], scopedCtx => installConversationPipeline(
    scopedCtx.uiConversation,
    () => settings.getSnapshot().enabled && settings.getSnapshot().fastPipeline,
  ))
}

/**
 * Register the typewriter renderer after the conversation package declares the
 * keyed Chat node seat. A lower priority shadows the built-in assistant row;
 * every other keyed renderer is wrapped in place so Context, commands, Tool
 * cards, retries, and workflow runs share one extensible follow boundary. The
 * Host-bridged configuration
 * selects the render direction, smoothing preset, and glide speed; the
 * plugin-owned settings RPC supplies the live auto-expand preference when the
 * settings surface is composed.
 * @param ctx - Browser context carrying the shared slot registry.
 */
export function apply(ctx: ClientContext): void {
  const config = readBootConfig()
  const settings = new SettingsCell()
  const syncStyles = (): void => { syncFastFold(settings.getSnapshot().enabled && settings.getSnapshot().fastFold) }
  syncStyles()
  const offStyles = settings.subscribe(syncStyles)
  ctx.effect(() => () => {
    offStyles()
    document.documentElement.removeAttribute('data-smooth-stream-fast-fold')
    document.getElementById(FAST_FOLD_STYLE_ID)?.remove()
  })
  healDshConversationPipeline(ctx, settings)
  const useControlScroll = (): boolean => useSyncExternalStore(
    settings.subscribe,
    () => settings.getSnapshot().controlScroll,
    () => settings.getSnapshot().controlScroll,
  )
  // The card talks to the plugin-owned loopback RPC, so the core settings
  // namespace allowlist cannot make it disappear. The stream still applies
  // with defaults when the optional Settings UI or Connection is absent.
  ctx.inject(['slots', 'locale', 'connection'], (settingsCtx) => {
    const card = new SmoothStreamCardController(
      // The shared Context augmentation also carries the Host-side Connection
      // shape. This browser entry runs after the client provider installs its
      // handle, so narrow through unknown to its client contract here.
      createSmoothStreamSettingsApi(settingsCtx.get('connection') as unknown as ConnectionHandle),
    )
    const detachSettings = settings.attach(card)
    const syncDebug = (): void => {
      const snapshot = card.getSnapshot()
      debugRuntime.syncSettings({
        available: snapshot.debugAvailable,
        enabled: snapshot.debugEnabled,
        writable: snapshot.writable && !snapshot.saving,
        dirty: snapshot.dirty,
        status: snapshot.status,
        tuning: snapshot.debugTuning,
      })
    }
    const detachBinding = debugRuntime.bindSettings({
      edit: patch => { card.inject().edit(patch) },
      save: () => { card.inject().save() },
      discard: () => { card.inject().discard() },
    })
    const detachDebug = card.subscribe(syncDebug)
    syncDebug()
    card.start()
    settingsCtx.effect(() => settingsCtx.locale.register(SETTINGS_NS, { zh, en }), 'dsh-smooth-stream: settings dictionaries')

    const SmoothStreamSectionView = (props: any) => createElement(
      'div',
      { style: { width: '100%', maxWidth: '760px', minHeight: '240px', display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0 24px 0' } },
      createElement('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 600 } }, '平滑流式输出'),
      createElement('p', { style: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: '13px' } }, '流畅打字机渲染、丝滑平稳滚动与思考过程折叠配置。'),
      createElement('ul', { style: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column' } }, createElement(SmoothStreamCard as any, { ...props, cardController: card, defaultOpen: true })),
    )

    // 1. 注册为全局设置左侧一级菜单「平滑流式」
    settingsCtx.slots.inject('settings.section', () => settingsCtx.slots.register({
      name: 'settings.section',
      id: 'smooth-stream',
      order: 25,
      label: () => '平滑流式',
      locale: SETTINGS_NS,
      inject: () => card.inject(),
    }, SmoothStreamSectionView))

    // 2. 像 dsh-agy 一样注册进官方内置插件页面下的二级 Tab（官方原生插槽，更新永不消失）
    settingsCtx.slots.inject('settings.plugins.tab', () => settingsCtx.slots.register({
      name: 'settings.plugins.tab',
      id: 'smooth-stream-tab',
      order: 15,
      label: () => '平滑流式',
      locale: SETTINGS_NS,
      inject: () => card.inject(),
    }, SmoothStreamSectionView))

    settingsCtx.slots.inject('conversation.session.header.utilities', () => settingsCtx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'smooth-stream-debug',
      order: 40,
      locale: SETTINGS_NS,
      inject: () => debugRuntime.panelFace(),
    }, DebugPanel))
    return () => {
      card.stop()
      detachDebug()
      detachSettings()
      detachBinding()
    }
  })

  ctx.slots.inject('conversation.chat.node', () => {
    const release = installRendererAdapter(ctx, (key, original) => {
      if (!isWrappableComponent(original) || SKIP_WRAP.has(key)) return original
      const Inner = original
      // Stable across settings/parent updates: do not reset tool-local hooks.
      const Follow = key === 'assistant-step' ? undefined
        : wrapFollowNodeView(Inner as ComponentType<FollowWrapProps>, useControlScroll)
      return function SmoothStreamRendererAdapter(props: AssistantProps & FollowWrapProps) {
        const preferences = useSyncExternalStore(settings.subscribe, settings.getSnapshot, settings.getSnapshot)
        if (!preferences.enabled) return createElement(Inner, props)
        if (key === 'assistant-step') {
          return createElement(NativeAssistantNodeView, {
            Inner: Inner as unknown as ComponentType<AssistantProps>,
            owner: props as AssistantProps,
            preferences: {
              controlScroll: preferences.controlScroll,
              motionPreference: preferences.motionPreference,
              logarithmicFade: preferences.logarithmicFade,
              thinkAutoExpand: preferences.thinkAutoExpand,
              keepStreamOnToolCall: preferences.keepStreamOnToolCall,
              preset: config.preset,
            },
          })
        }
        return createElement(Follow ?? Inner, props)
      }
      })
    return release
  })
}
