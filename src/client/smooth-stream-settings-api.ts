/** Browser adapter for the Host-owned smooth-stream settings RPC. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { DEFAULT_STREAM_DEBUG_TUNING, DEFAULT_STREAM_SETTINGS, type StreamDebugTuning, type StreamSettings } from '../settings.ts'
import {
  STREAM_SETTINGS_RPC,
  STREAM_SETTINGS_RPC_CHANNEL,
  type StreamDebugSettingsView,
  type StreamSettingsView,
  type StreamUpgradeView,
} from '../settings-api.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function settingsView(value: unknown): StreamSettingsView {
  const data = record(value)
  if (data === undefined
    || typeof data.version !== 'string'
    || !['npm', 'development', 'unmanaged'].includes(data.installation as string)
    || typeof data.writable !== 'boolean'
    || typeof data.enabled !== 'boolean'
    || typeof data.controlScroll !== 'boolean'
    || !['auto', 'force-smooth', 'force-reduced'].includes(data.motionPreference as string)
    || (data.backgroundRecovery !== undefined && !['replay', 'catch-up', 'latest'].includes(data.backgroundRecovery as string))
    || (data.foregroundRecoveryDelayMs !== undefined && (typeof data.foregroundRecoveryDelayMs !== 'number'
       || !Number.isInteger(data.foregroundRecoveryDelayMs) || data.foregroundRecoveryDelayMs < 0 || data.foregroundRecoveryDelayMs > 10000))
     || typeof data.thinkAutoExpand !== 'boolean'
    || (data.logarithmicFade !== undefined && typeof data.logarithmicFade !== 'boolean')
    || (data.keepStreamOnToolCall !== undefined && typeof data.keepStreamOnToolCall !== 'boolean')
    || typeof data.canUpgrade !== 'boolean') {
    throw new Error('dsh-smooth-stream: malformed settings response')
  }
  return {
    ...data,
    backgroundRecovery: data.backgroundRecovery ?? DEFAULT_STREAM_SETTINGS.backgroundRecovery,
    foregroundRecoveryDelayMs: data.foregroundRecoveryDelayMs ?? DEFAULT_STREAM_SETTINGS.foregroundRecoveryDelayMs,
    logarithmicFade: data.logarithmicFade ?? DEFAULT_STREAM_SETTINGS.logarithmicFade,
    fastFold: data.fastFold ?? DEFAULT_STREAM_SETTINGS.fastFold,
    fastPipeline: data.fastPipeline ?? DEFAULT_STREAM_SETTINGS.fastPipeline,
    keepStreamOnToolCall: data.keepStreamOnToolCall ?? DEFAULT_STREAM_SETTINGS.keepStreamOnToolCall,
  } as unknown as StreamSettingsView
}

function upgradeView(value: unknown): StreamUpgradeView {
  const data = record(value)
  if (data?.restartRequired !== true) throw new Error('dsh-smooth-stream: malformed update response')
  return { restartRequired: true }
}

function debugSettingsView(value: unknown): StreamDebugSettingsView {
  const data = record(value)
  const tuning = record(data?.tuning)
  if (data === undefined
    || typeof data.debugEnabled !== 'boolean'
    || (data.debugTuningEnabled !== undefined && typeof data.debugTuningEnabled !== 'boolean')
    || tuning === undefined
    || typeof tuning.revealScale !== 'number'
    || typeof tuning.queuePressure !== 'number'
    || typeof tuning.maxRevealCps !== 'number'
    || (tuning.cadenceClamp !== undefined && typeof tuning.cadenceClamp !== 'number')
    || typeof tuning.springStiffness !== 'number'
    || typeof tuning.springDamping !== 'number'
    || typeof tuning.springMass !== 'number'
    || typeof tuning.runwayPx !== 'number'
    || typeof tuning.reserveResponseMs !== 'number'
    || typeof tuning.backpressureMinScale !== 'number') {
    throw new Error('dsh-smooth-stream: malformed debug settings response')
  }
  return {
    debugEnabled: data.debugEnabled,
    // A legacy Host used the diagnostics switch as the tuning switch.
    debugTuningEnabled: data.debugTuningEnabled ?? data.debugEnabled,
    tuning: {
      ...(tuning as unknown as StreamDebugTuning),
      cadenceClamp: tuning.cadenceClamp ?? DEFAULT_STREAM_DEBUG_TUNING.cadenceClamp,
    },
  }
}

function accepted(result: Awaited<ReturnType<ConnectionHandle['rpc']['call']>>): unknown {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Narrow client contract consumed by the staged settings-card controller. */
export interface SmoothStreamSettingsApi {
  read(): Promise<StreamSettingsView>
  write(settings: Pick<StreamSettings, 'enabled' | 'controlScroll' | 'motionPreference' | 'backgroundRecovery' | 'foregroundRecoveryDelayMs' | 'thinkAutoExpand' | 'logarithmicFade' | 'fastFold' | 'fastPipeline' | 'keepStreamOnToolCall'> & Partial<Pick<StreamSettings, 'debugEnabled' | 'debugTuningEnabled' | 'debugTuning'>>): Promise<StreamSettingsView>
  readDebug(): Promise<StreamDebugSettingsView>
  writeDebug(settings: Pick<StreamSettings, 'debugEnabled' | 'debugTuningEnabled' | 'debugTuning'>): Promise<StreamDebugSettingsView>
  upgrade(): Promise<StreamUpgradeView>
}

/** Build the typed facade over the generic Connection RPC service. */
export function createSmoothStreamSettingsApi(connection: ConnectionHandle): SmoothStreamSettingsApi {
  return {
    async read(): Promise<StreamSettingsView> {
      return settingsView(accepted(await connection.rpc.call(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.read, {})))
    },
    async write(settings: Pick<StreamSettings, 'enabled' | 'controlScroll' | 'motionPreference' | 'backgroundRecovery' | 'foregroundRecoveryDelayMs' | 'thinkAutoExpand' | 'logarithmicFade' | 'fastFold' | 'fastPipeline' | 'keepStreamOnToolCall'> & Partial<Pick<StreamSettings, 'debugEnabled' | 'debugTuningEnabled' | 'debugTuning'>>): Promise<StreamSettingsView> {
      return settingsView(accepted(await connection.rpc.call(
        STREAM_SETTINGS_RPC_CHANNEL,
        STREAM_SETTINGS_RPC.write,
        {
          enabled: settings.enabled,
          controlScroll: settings.controlScroll,
          motionPreference: settings.motionPreference,
          backgroundRecovery: settings.backgroundRecovery,
          foregroundRecoveryDelayMs: settings.foregroundRecoveryDelayMs,
          thinkAutoExpand: settings.thinkAutoExpand,
          logarithmicFade: settings.logarithmicFade,
          fastFold: settings.fastFold,
          fastPipeline: settings.fastPipeline,
          keepStreamOnToolCall: settings.keepStreamOnToolCall,
          ...(settings.debugEnabled === undefined ? {} : { debugEnabled: settings.debugEnabled }),
          ...(settings.debugTuningEnabled === undefined ? {} : { debugTuningEnabled: settings.debugTuningEnabled }),
          ...(settings.debugTuning === undefined ? {} : { debugTuning: settings.debugTuning }),
        },
      )))
    },
    async readDebug(): Promise<StreamDebugSettingsView> {
      return debugSettingsView(accepted(await connection.rpc.call(
        STREAM_SETTINGS_RPC_CHANNEL,
        STREAM_SETTINGS_RPC.debugRead,
        {},
      )))
    },
    async writeDebug(settings: Pick<StreamSettings, 'debugEnabled' | 'debugTuningEnabled' | 'debugTuning'>): Promise<StreamDebugSettingsView> {
      return debugSettingsView(accepted(await connection.rpc.call(
        STREAM_SETTINGS_RPC_CHANNEL,
        STREAM_SETTINGS_RPC.debugWrite,
        { debugEnabled: settings.debugEnabled, debugTuningEnabled: settings.debugTuningEnabled, tuning: settings.debugTuning },
      )))
    },
    async upgrade(): Promise<StreamUpgradeView> {
      return upgradeView(accepted(await connection.rpc.call(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.upgrade, {})))
    },
  }
}
