import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SmoothStreamCardController } from '../src/client/smooth-stream-card-controller.ts'
import { createSmoothStreamSettingsApi } from '../src/client/smooth-stream-settings-api.ts'
import { STREAM_SETTINGS_RPC, STREAM_SETTINGS_RPC_CHANNEL } from '../src/settings-api.ts'
import { DEFAULT_STREAM_SETTINGS } from '../src/settings.ts'

const currentView = {
  ...DEFAULT_STREAM_SETTINGS,
  version: '0.11.0-rebuild.3',
  installation: 'development',
  writable: true,
  canUpgrade: false,
  controlScroll: false,
  motionPreference: 'force-reduced',
  thinkAutoExpand: false,
  logarithmicFade: false,
}

afterEach(() => { localStorage.clear() })

describe('current runtime settings compatibility', () => {
  it.each(['replay', 'catch-up', 'latest', { obsolete: true }])(
    'ignores retired RPC fields while retaining current preferences: %j',
    async (backgroundRecovery: 'replay' | 'catch-up' | 'latest' | { obsolete: boolean }) => {
      const call = vi.fn(async () => ({ ok: true, value: {
        ...currentView, backgroundRecovery, foregroundRecoveryDelayMs: 'obsolete-delay',
      } }))
      const api = createSmoothStreamSettingsApi({ rpc: { call } } as unknown as ConnectionHandle)
      const loaded = await api.read()
      expect(loaded).toMatchObject({
        controlScroll: false, motionPreference: 'force-reduced', thinkAutoExpand: false,
      })
      expect(loaded).not.toHaveProperty('logarithmicFade')
      expect(loaded).not.toHaveProperty('backgroundRecovery')
      expect(loaded).not.toHaveProperty('foregroundRecoveryDelayMs')
      const legacy = { ...DEFAULT_STREAM_SETTINGS, backgroundRecovery, foregroundRecoveryDelayMs: -999, logarithmicFade: false }
      const written = await api.write(legacy)
      expect(written).not.toHaveProperty('backgroundRecovery')
      expect(written).not.toHaveProperty('foregroundRecoveryDelayMs')
      expect(written).not.toHaveProperty('logarithmicFade')
      const payload = call.mock.calls.at(-1)
      expect(payload).toEqual([STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.write, {
        enabled: legacy.enabled,
        controlScroll: legacy.controlScroll,
        motionPreference: legacy.motionPreference,
        thinkAutoExpand: legacy.thinkAutoExpand,
        fastFold: legacy.fastFold,
        fastPipeline: legacy.fastPipeline,
        keepStreamOnToolCall: legacy.keepStreamOnToolCall,
        debugEnabled: legacy.debugEnabled,
        debugTuningEnabled: legacy.debugTuningEnabled,
        debugTuning: legacy.debugTuning,
      }])
    },
  )

  it('keeps current local preferences when a legacy cache includes retired fields', async () => {
    localStorage.setItem('dsh-smooth-stream:settings', JSON.stringify({
      ...currentView,
      backgroundRecovery: { obsolete: true },
      foregroundRecoveryDelayMs: 'obsolete-delay',
    }))
    const call = vi.fn(async () => { throw new Error('Host unavailable') })
    const api = createSmoothStreamSettingsApi({ rpc: { call } } as unknown as ConnectionHandle)
    const controller = new SmoothStreamCardController(api)
    controller.start()
    await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', controlScroll: false, motionPreference: 'force-reduced',
      thinkAutoExpand: false,
    }))
    expect(controller.getSnapshot()).not.toHaveProperty('logarithmicFade')
    expect(controller.values()).not.toHaveProperty('logarithmicFade')
    expect(controller.values()).not.toHaveProperty('backgroundRecovery')
    expect(controller.values()).not.toHaveProperty('foregroundRecoveryDelayMs')
    controller.stop()
  })
})
