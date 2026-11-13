import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_STREAM_CONFIG, type StreamConfig } from './config.ts'
import { injectStreamConfig } from './boot-config.ts'
import { STREAM_PACKAGE_NAME, STREAM_PACKAGE_VERSION } from './package-meta.ts'
import { inspectProfileInstallation, updateNpmProfilePackage } from './profile-installation.ts'
import { registerSettingsChannel } from './settings-channel.ts'
import {
  STREAM_SETTINGS_RPC,
  STREAM_SETTINGS_RPC_CHANNEL,
  type StreamDebugSettingsView,
  type StreamSettingsView,
} from './settings-api.ts'
import {
  DEFAULT_STREAM_SETTINGS,
  STREAM_SETTINGS_NS,
  type StreamDebugTuning,
  type StreamSettings,
} from './settings.ts'

/** Display name shown by the Host loader while the plugin is mounted. */
export const name = 'dsh-smooth-stream'

/**
 * Plugin configuration accepted from the overlay's `config` section. Cordis
 * validates the value against this schema at load and fills omitted fields
 * from the shared defaults, so an invalid value fails the load loudly.
 */
export interface Config extends StreamConfig {}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['typewriter', 'teleprompter'] as const).default(DEFAULT_STREAM_CONFIG.mode),
  preset: Schema.union(['realtime', 'balanced', 'silky'] as const).default(DEFAULT_STREAM_CONFIG.preset),
  revealCharsPerSec: Schema.number()
    .min(5)
    .max(200)
    .default(DEFAULT_STREAM_CONFIG.revealCharsPerSec),
  scrollSpeedPxPerSec: Schema.number()
    .min(1)
    .max(200)
    .default(DEFAULT_STREAM_CONFIG.scrollSpeedPxPerSec),
  maxScrollSpeedPxPerSec: Schema.number()
    .min(1)
    .max(2000)
    .default(DEFAULT_STREAM_CONFIG.maxScrollSpeedPxPerSec),
})

/**
 * Schema of the user-owned settings section. The Host keeps it in the plugin's
 * local JSON file while the browser edits it through the authenticated RPC.
 */
export const StreamSettingsSchema: Schema<StreamSettings> = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.enabled),
  controlScroll: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.controlScroll),
  motionPreference: Schema.union([
    Schema.const('auto'),
    Schema.const('force-smooth'),
    Schema.const('force-reduced'),
  ] as const).default(DEFAULT_STREAM_SETTINGS.motionPreference),
  thinkAutoExpand: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.thinkAutoExpand),
  logarithmicFade: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.logarithmicFade),
  fastFold: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.fastFold),
  fastPipeline: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.fastPipeline),
  keepStreamOnToolCall: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.keepStreamOnToolCall),
  debugEnabled: Schema.boolean().default(DEFAULT_STREAM_SETTINGS.debugEnabled),
  debugTuning: Schema.object({
    revealScale: Schema.number().min(0.25).max(2).default(DEFAULT_STREAM_SETTINGS.debugTuning.revealScale),
    queuePressure: Schema.number().min(0).max(2).default(DEFAULT_STREAM_SETTINGS.debugTuning.queuePressure),
    maxRevealCps: Schema.number().min(120).max(1000).default(DEFAULT_STREAM_SETTINGS.debugTuning.maxRevealCps),
    cadenceClamp: Schema.number().min(1).max(24).default(DEFAULT_STREAM_SETTINGS.debugTuning.cadenceClamp ?? 4),
    springStiffness: Schema.number().min(40).max(320).default(DEFAULT_STREAM_SETTINGS.debugTuning.springStiffness),
    springDamping: Schema.number().min(8).max(80).default(DEFAULT_STREAM_SETTINGS.debugTuning.springDamping),
    springMass: Schema.number().min(0.5).max(3).default(DEFAULT_STREAM_SETTINGS.debugTuning.springMass),
    runwayPx: Schema.number().min(0).max(120).default(DEFAULT_STREAM_SETTINGS.debugTuning.runwayPx),
    reserveResponseMs: Schema.number().min(60).max(600).default(DEFAULT_STREAM_SETTINGS.debugTuning.reserveResponseMs),
    backpressureMinScale: Schema.number().min(0.25).max(1).default(DEFAULT_STREAM_SETTINGS.debugTuning.backpressureMinScale),
  }),
})

/**
 * Host half: log the resolved configuration and bridge it to the browser
 * half. The web boot graph carries no per-entry config, so the validated
 * value is injected into every served index response as a boot global the
 * client entry reads at apply time.
 * @param ctx - Host context carrying the web server service when composed.
 * @param config - Schema-validated configuration with defaults filled.
 */
export function apply(ctx: Context, config: Config): void {
  console.log(
    `[dsh-smooth-stream] plugin loaded! mode=${config.mode} preset=${config.preset} `
    + `seed=${config.revealCharsPerSec}cps scroll=${config.scrollSpeedPxPerSec}px/s `
    + `maxScroll=${config.maxScrollSpeedPxPerSec}px/s`,
  )

  const SETTINGS_FILE = join(process.env.DSH_HOME || '/root/.dsh', 'storages', 'smooth-stream-settings.json')

  function loadSettings(): StreamSettings {
    try {
      if (existsSync(SETTINGS_FILE)) {
        const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
        return StreamSettingsSchema(saved)
      }
    } catch (e) {
      console.warn('[dsh-smooth-stream] loadSettings error:', e)
    }
    return {
      ...DEFAULT_STREAM_SETTINGS,
      debugTuning: { ...DEFAULT_STREAM_SETTINGS.debugTuning },
    }
  }

  function saveSettings(settings: StreamSettings): void {
    try {
      mkdirSync(dirname(SETTINGS_FILE), { recursive: true })
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8')
    } catch (e) {
      console.warn('[dsh-smooth-stream] saveSettings error:', e)
    }
  }

  let currentSettings: StreamSettings = loadSettings()

  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(
      () => httpCtx.webServer.tapIndex(html => injectStreamConfig(html, config)),
      'dsh-smooth-stream: boot config bridge',
    )

    httpCtx.inject(['connection'], (_connectionCtx) => {
      const view = (): StreamSettingsView => {
        const installation = inspectProfileInstallation(httpCtx.baseUrl, STREAM_PACKAGE_NAME)
        return {
          version: STREAM_PACKAGE_VERSION,
          installation: installation.kind,
          writable: true,
          enabled: currentSettings.enabled,
          controlScroll: currentSettings.controlScroll,
          motionPreference: currentSettings.motionPreference,
          thinkAutoExpand: currentSettings.thinkAutoExpand,
          logarithmicFade: currentSettings.logarithmicFade,
          fastFold: currentSettings.fastFold ?? DEFAULT_STREAM_SETTINGS.fastFold,
          fastPipeline: currentSettings.fastPipeline ?? DEFAULT_STREAM_SETTINGS.fastPipeline,
          keepStreamOnToolCall: currentSettings.keepStreamOnToolCall,
          canUpgrade: installation.kind === 'npm',
        }
      }

      const debugView = (): StreamDebugSettingsView => ({
        debugEnabled: currentSettings.debugEnabled,
        tuning: { ...currentSettings.debugTuning },
      })

      const validDebugTuning = (value: unknown): value is StreamDebugTuning => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
        const tuning = value as Record<string, unknown>
        return typeof tuning.revealScale === 'number'
          && tuning.revealScale >= 0.25 && tuning.revealScale <= 2
          && typeof tuning.queuePressure === 'number'
          && tuning.queuePressure >= 0 && tuning.queuePressure <= 2
          && typeof tuning.maxRevealCps === 'number'
          && tuning.maxRevealCps >= 120 && tuning.maxRevealCps <= 1000
          && typeof tuning.springStiffness === 'number'
          && tuning.springStiffness >= 40 && tuning.springStiffness <= 320
          && typeof tuning.springDamping === 'number'
          && tuning.springDamping >= 8 && tuning.springDamping <= 80
          && typeof tuning.springMass === 'number'
          && tuning.springMass >= 0.5 && tuning.springMass <= 3
          && typeof tuning.runwayPx === 'number'
          && tuning.runwayPx >= 0 && tuning.runwayPx <= 120
          && typeof tuning.reserveResponseMs === 'number'
          && tuning.reserveResponseMs >= 60 && tuning.reserveResponseMs <= 600
          && typeof tuning.backpressureMinScale === 'number'
          && tuning.backpressureMinScale >= 0.25 && tuning.backpressureMinScale <= 1
      }

    let upgrade: Promise<void> | undefined

    const rejectedSettings = (message: string) => ({
      ok: false as const,
      error: { code: 'settings-rejected', message, details: { ns: STREAM_SETTINGS_NS } },
    })

    const handle: ConnectionRpcHandler = async (endpoint, payload, _signal, _peer) => {
      if (endpoint === STREAM_SETTINGS_RPC.read) return { ok: true, value: view() }
      if (endpoint === STREAM_SETTINGS_RPC.write) {
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          return {
            ok: false,
            error: {
              code: 'settings-rejected',
              message: 'payload must be an object',
              details: { ns: STREAM_SETTINGS_NS },
            },
          }
        }
        const next = payload as Record<string, unknown>
        const allowedKeys = new Set([
          'enabled', 'controlScroll', 'motionPreference', 'thinkAutoExpand', 'logarithmicFade',
          'fastFold', 'fastPipeline', 'keepStreamOnToolCall', 'debugEnabled', 'debugTuning',
        ])
        if (Object.keys(next).some(key => !allowedKeys.has(key))) {
          return rejectedSettings('settings payload contains an unknown field')
        }
        const booleanKeys = [
          'enabled', 'controlScroll', 'thinkAutoExpand', 'logarithmicFade',
          'fastFold', 'fastPipeline', 'keepStreamOnToolCall', 'debugEnabled',
        ] as const
        if (booleanKeys.some(key => key in next && typeof next[key] !== 'boolean')) {
          return rejectedSettings('settings payload contains an invalid boolean')
        }
        if ('motionPreference' in next
          && next.motionPreference !== 'auto'
          && next.motionPreference !== 'force-smooth'
          && next.motionPreference !== 'force-reduced') {
          return rejectedSettings('settings payload contains an invalid motionPreference')
        }
        if ('debugTuning' in next && !validDebugTuning(next.debugTuning)) {
          return rejectedSettings('settings payload contains invalid debugTuning')
        }
        const parsed = StreamSettingsSchema({
          ...currentSettings,
          ...next,
          debugTuning: next.debugTuning === undefined
            ? currentSettings.debugTuning
            : { ...currentSettings.debugTuning, ...(next.debugTuning as object) },
        })
        currentSettings = parsed
        saveSettings(currentSettings)
        return { ok: true, value: view() }
      }
      if (endpoint === STREAM_SETTINGS_RPC.debugRead) return { ok: true, value: debugView() }
      if (endpoint === STREAM_SETTINGS_RPC.debugWrite) {
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          return {
            ok: false,
            error: {
              code: 'settings-rejected',
              message: 'debug settings must be an object',
              details: { ns: STREAM_SETTINGS_NS },
            },
          }
        }
        const next = payload as { debugEnabled?: unknown; tuning?: unknown }
        if (Object.keys(next).some(key => key !== 'debugEnabled' && key !== 'tuning')) {
          return rejectedSettings('debug settings contain an unknown field')
        }
        if (next.debugEnabled !== undefined && typeof next.debugEnabled !== 'boolean') {
          return rejectedSettings('debugEnabled must be a boolean')
        }
        if (next.tuning !== undefined && !validDebugTuning(next.tuning)) {
          return rejectedSettings('debug tuning is invalid')
        }
        currentSettings = StreamSettingsSchema({
          ...currentSettings,
          ...(next.debugEnabled === undefined ? {} : { debugEnabled: next.debugEnabled }),
          ...(next.tuning === undefined ? {} : {
            debugTuning: { ...currentSettings.debugTuning, ...(next.tuning as object) },
          }),
        })
        saveSettings(currentSettings)
        return { ok: true, value: debugView() }
      }
      if (endpoint === STREAM_SETTINGS_RPC.upgrade) {
        const baseUrl = httpCtx.baseUrl
        const installation = inspectProfileInstallation(baseUrl, STREAM_PACKAGE_NAME)
        if (installation.kind !== 'npm') {
          return { ok: false, error: { code: 'internal', message: 'smooth-stream is not an npm profile dependency', details: {} } }
        }
        if (upgrade !== undefined) {
          return { ok: false, error: { code: 'internal', message: 'smooth-stream update is already running', details: {} } }
        }
        upgrade = updateNpmProfilePackage(installation.profileDir, STREAM_PACKAGE_NAME)
        try {
          await upgrade
        } catch {
          return { ok: false, error: { code: 'internal', message: 'smooth-stream update failed', details: {} } }
        } finally {
          upgrade = undefined
        }
        return { ok: true, value: { restartRequired: true } }
      }
      return { ok: false, error: { code: 'internal', message: `unknown smooth-stream endpoint ${JSON.stringify(endpoint)}`, details: {} } }
    }

    registerSettingsChannel(httpCtx, STREAM_SETTINGS_RPC_CHANNEL, handle)
    })
  })
}
