import { cleanup, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createElement, type FunctionComponent } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { cleanup() })

function assistantProps(t: (key: string) => string): Record<string, unknown> {
  return {
    node: {
      kind: 'assistant-step',
      location: { kind: 'unresolved' },
      data: {
        status: 'running',
        blocks: [{ kind: 'reasoning', text: 'latest tokens' }],
        turn: 1,
        step: 1,
        time: 0,
      },
    },
    loadImage: async () => new Blob(),
    useTurnData: () => undefined,
    openFile: () => {},
    fileMentions: () => undefined,
    t,
  }
}

async function localeBench(): Promise<{
  ctx: Context
  locale: LocaleRuntime
  component: FunctionComponent<Record<string, unknown>>
  native: FunctionComponent<Record<string, unknown>>
  entry: ReturnType<SlotRegistry['entries']>[number]
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const locale = new LocaleRuntime(ctx)
  locale.register('conversation', {
    zh: { 'image.label': '图片', 'row.running': '正在生成' },
    en: { 'image.label': 'Image', 'row.running': 'Generating' },
  } as never)
  locale.register('chat', {
    zh: { 'message.think': 'Harness 思考' },
    en: { 'message.think': 'Harness Thinking' },
  } as never)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  ctx.provide('connection', {
    rpc: { call: async (_channel: string, endpoint: string) => ({
      ok: true,
      value: endpoint === 'settings.read' ? {
        version: '0.2.2', installation: 'development', writable: true,
        enabled: true, controlScroll: true, motionPreference: 'auto',
        thinkAutoExpand: true, logarithmicFade: true, fastFold: true,
        fastPipeline: true, keepStreamOnToolCall: true, canUpgrade: false,
      } : endpoint === 'debug.read' ? {
        debugEnabled: false,
        tuning: { revealScale: 1, queuePressure: 0.85, maxRevealCps: 600, cadenceClamp: 4,
          springStiffness: 130, springDamping: 24, springMass: 1, runwayPx: 72,
          reserveResponseMs: 180, backpressureMinScale: 0.55 },
      } : {},
    }) },
  } as never)

  const native: FunctionComponent<Record<string, unknown>> = (props) => createElement('output', null,
    String((props.t as (key: string) => string)('message.think')))
  slots.register({
    name: 'root',
    children: {
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
  slots.register({ name: 'conversation.chat.node', key: 'assistant-step', locale: 'chat',
    children: { 'conversation.chat.reasoning.body': { kind: 'single', scope: 'session' } },
    inject: () => ({ marker: 'native-inject' }) } as never, native as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entry = slots.entries('conversation.chat.node').find(item => item.options.key === 'assistant-step')
  if (entry === undefined) throw new Error('native assistant registration was not retained')
  return {
    ctx, locale, native, entry,
    component: entry.component as FunctionComponent<Record<string, unknown>>,
    dispose: () => fiber.dispose(),
  }
}

function chatT(locale: LocaleRuntime): (key: string) => string {
  return locale.bind('chat') as unknown as (key: string) => string
}

describe('assistant renderer locale routing', () => {
  it('passes the official Chat locale and registration metadata through the in-place wrapper', async () => {
    const { locale, component, native, entry, dispose } = await localeBench()
    expect(component).not.toBe(native)
    expect(entry.locale).toBe('chat')
    expect(entry.children).toBeDefined()
    expect(entry.inject).toBeDefined()
    const view = render(createElement(component, assistantProps(chatT(locale))))

    expect(view.getByText('Harness 思考')).toBeTruthy()
    expect(view.container.textContent).not.toContain('message.think')
    await dispose()
  })
})
