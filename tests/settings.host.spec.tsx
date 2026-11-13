/** Host settings persist in the plugin-owned JSON file and use Connection RPC. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, PeerScope } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it } from 'vitest'
import { STREAM_PACKAGE_NAME, STREAM_PACKAGE_VERSION } from '../src/package-meta.ts'
import { apply, Config } from '../src/plugin.ts'
import { STREAM_SETTINGS_RPC, STREAM_SETTINGS_RPC_CHANNEL } from '../src/settings-api.ts'
import { DEFAULT_STREAM_SETTINGS } from '../src/settings.ts'

interface RpcRegistration {
  channel: string
  handler: ConnectionRpcHandler
}

const tempDirs = new Set<string>()
const originalDshHome = process.env.DSH_HOME
const peer = { principal: { kind: 'owner' } } as PeerScope
const signal = () => new AbortController().signal

afterEach(() => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true })
  tempDirs.clear()
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

function profileBaseUrl(specifier: string, bundled = true): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-smooth-stream-profile-'))
  tempDirs.add(directory)
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: 'dsh-profile-test',
    private: true,
    dsh: { profile: { bundles: bundled ? [STREAM_PACKAGE_NAME] : [] } },
    dependencies: { [STREAM_PACKAGE_NAME]: specifier },
  }), 'utf8')
  return `${pathToFileURL(directory).href}/`
}

async function mountHost(baseUrl: string, sharedHome?: string): Promise<{
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  registration: RpcRegistration
  removed: () => number
  settingsFile: string
}> {
  const home = sharedHome ?? mkdtempSync(join(tmpdir(), 'dsh-smooth-stream-home-'))
  if (sharedHome === undefined) tempDirs.add(home)
  process.env.DSH_HOME = home
  const ctx = new Context()
  ctx.baseUrl = baseUrl
  let registration: RpcRegistration | undefined
  let removeCalls = 0
  ctx.provide('connection', {
    baseUrl,
    rpc: {
      handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void> {
        registration = { channel, handler }
        return async () => { removeCalls += 1 }
      },
    },
  } as never)
  ctx.provide('webServer', { tapIndex: () => () => {}, register: () => () => {} } as never)
  const fiber = ctx.plugin({ apply, Config })
  await fiber.await()
  if (registration === undefined) throw new Error('smooth-stream RPC was not registered')
  return {
    ctx,
    fiber,
    registration,
    removed: () => removeCalls,
    settingsFile: join(home, 'storages', 'smooth-stream-settings.json'),
  }
}

describe('smooth-stream host settings', () => {
  it('persists updates, preserves omitted values, and rejects invalid input atomically', async () => {
    const host = await mountHost(profileBaseUrl(`link:${process.cwd()}`))
    const { registration } = host
    expect(await registration.handler(STREAM_SETTINGS_RPC.write, { enabled: false, logarithmicFade: false }, signal(), peer))
      .toMatchObject({ ok: true, value: { enabled: false, logarithmicFade: false } })
    expect(await registration.handler(STREAM_SETTINGS_RPC.write, { controlScroll: false }, signal(), peer))
      .toMatchObject({ ok: true, value: { enabled: false, controlScroll: false, logarithmicFade: false } })
    const beforeInvalid = readFileSync(host.settingsFile, 'utf8')
    for (const invalid of [
      { enabled: true, thinkAutoExpand: 'false' },
      { motionPreference: 'shake' },
      { unknownOption: true },
      { debugTuning: { ...DEFAULT_STREAM_SETTINGS.debugTuning, springMass: 99 } },
      null,
      [],
    ]) {
      expect(await registration.handler(STREAM_SETTINGS_RPC.write, invalid, signal(), peer)).toMatchObject({
        ok: false,
        error: { code: 'settings-rejected' },
      })
      expect(readFileSync(host.settingsFile, 'utf8')).toBe(beforeInvalid)
    }
    expect(JSON.parse(beforeInvalid)).toMatchObject({ enabled: false, controlScroll: false, logarithmicFade: false })
    await host.fiber.dispose()
  })

  it('reads defaults and debug settings, writes tuning, and disposes registration', async () => {
    const host = await mountHost(profileBaseUrl(`link:${process.cwd()}`))
    expect(host.registration.channel).toBe(STREAM_SETTINGS_RPC_CHANNEL)
    expect(await host.registration.handler(STREAM_SETTINGS_RPC.read, {}, signal(), peer)).toMatchObject({
      ok: true,
      value: {
        version: STREAM_PACKAGE_VERSION,
        installation: 'development',
        writable: true,
        enabled: DEFAULT_STREAM_SETTINGS.enabled,
        controlScroll: DEFAULT_STREAM_SETTINGS.controlScroll,
        motionPreference: DEFAULT_STREAM_SETTINGS.motionPreference,
        thinkAutoExpand: DEFAULT_STREAM_SETTINGS.thinkAutoExpand,
        logarithmicFade: DEFAULT_STREAM_SETTINGS.logarithmicFade,
        fastFold: DEFAULT_STREAM_SETTINGS.fastFold,
        fastPipeline: DEFAULT_STREAM_SETTINGS.fastPipeline,
        keepStreamOnToolCall: DEFAULT_STREAM_SETTINGS.keepStreamOnToolCall,
        canUpgrade: false,
      },
    })
    expect(await host.registration.handler(STREAM_SETTINGS_RPC.debugWrite, {
      debugEnabled: true,
      tuning: { ...DEFAULT_STREAM_SETTINGS.debugTuning, springDamping: 31 },
    }, signal(), peer)).toMatchObject({ ok: true, value: { debugEnabled: true, tuning: { springDamping: 31 } } })
    const debugFile = JSON.parse(readFileSync(host.settingsFile, 'utf8'))
    expect(debugFile).toMatchObject({ debugEnabled: true, debugTuning: { springDamping: 31 } })
    expect(await host.registration.handler(STREAM_SETTINGS_RPC.debugWrite, {
      debugEnabled: false,
      tuning: { ...DEFAULT_STREAM_SETTINGS.debugTuning, springMass: 99 },
    }, signal(), peer)).toMatchObject({ ok: false, error: { code: 'settings-rejected' } })
    expect(JSON.parse(readFileSync(host.settingsFile, 'utf8'))).toEqual(debugFile)

    await host.fiber.dispose()
    expect(host.removed()).toBe(1)
  })

  it('loads valid persisted values and falls back to defaults for invalid files', async () => {
    const host = await mountHost(profileBaseUrl(`link:${process.cwd()}`))
    await host.registration.handler(STREAM_SETTINGS_RPC.write, { enabled: false }, signal(), peer)
    const sharedHome = process.env.DSH_HOME as string
    await host.fiber.dispose()

    const reloaded = await mountHost(profileBaseUrl(`link:${process.cwd()}`), sharedHome)
    expect(await reloaded.registration.handler(STREAM_SETTINGS_RPC.read, {}, signal(), peer))
      .toMatchObject({ ok: true, value: { enabled: false } })
    writeFileSync(reloaded.settingsFile, JSON.stringify({ enabled: 'invalid' }), 'utf8')
    await reloaded.fiber.dispose()

    const fallback = await mountHost(profileBaseUrl(`link:${process.cwd()}`), sharedHome)
    expect(await fallback.registration.handler(STREAM_SETTINGS_RPC.read, {}, signal(), peer))
      .toMatchObject({ ok: true, value: { enabled: DEFAULT_STREAM_SETTINGS.enabled } })
    await fallback.fiber.dispose()
  })

  it('reads the running package version from its manifest', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string; version: string }
    expect(STREAM_PACKAGE_NAME).toBe(manifest.name)
    expect(STREAM_PACKAGE_VERSION).toBe(manifest.version)
  })

  it('enables upgrade only for a confirmed npm profile dependency', async () => {
    const npm = await mountHost(profileBaseUrl('^0.1.0'))
    expect(await npm.registration.handler(STREAM_SETTINGS_RPC.read, {}, signal(), peer))
      .toMatchObject({ ok: true, value: { installation: 'npm', canUpgrade: true } })
    await npm.fiber.dispose()

    const unmanaged = await mountHost(profileBaseUrl('workspace:*'))
    expect(await unmanaged.registration.handler(STREAM_SETTINGS_RPC.read, {}, signal(), peer))
      .toMatchObject({ ok: true, value: { installation: 'unmanaged', canUpgrade: false } })
    await unmanaged.fiber.dispose()
  })
})
