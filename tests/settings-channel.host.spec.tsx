/** The fallback channel preserves authenticated Host admission and RPC envelopes. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import { STREAM_SETTINGS_RPC_CHANNEL } from '../src/settings-api.ts'
import { registerSettingsChannel } from '../src/settings-channel.ts'

interface Exchange {
  status: number
  body: string
}

const mounted: Array<() => Promise<void>> = []
const peer = { principal: { kind: 'owner' } } as PeerScope

afterEach(async () => {
  for (const dispose of mounted.splice(0)) await dispose()
})

function fakeWebServer(routes: WebRoute[]): {
  register(route: WebRoute): () => void
} {
  return {
    register(route): () => void {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

async function mountHost(admitted: boolean): Promise<{ routes: WebRoute[]; dispose: () => Promise<void> }> {
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(process.cwd()).href}/`
  const routes: WebRoute[] = []
  ctx.provide('webServer', fakeWebServer(routes) as never)
  let admissions = 0
  ctx.provide('connection', {
    rpc: { handle: () => { throw new Error('cannot get property "webServer" without inject') } },
    admit: () => {
      admissions += 1
      return admitted ? { peer } : { rejection: 401 }
    },
  } as never)
  const handler: ConnectionRpcHandler = async (endpoint, payload, signal, rpcPeer) => ({
    ok: true,
    value: { endpoint, payload, aborted: signal.aborted, principal: rpcPeer.principal },
  })
  const fiber = ctx.plugin({
    apply(pluginCtx) { registerSettingsChannel(pluginCtx, STREAM_SETTINGS_RPC_CHANNEL, handler) },
  })
  await fiber.await()
  return { routes, dispose: () => fiber.dispose() }
}

async function call(
  route: WebRoute,
  endpoint: string,
  payload: unknown,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Exchange> {
  const req = Readable.from([Buffer.from(options.body ?? JSON.stringify({
    type: 'client-request', rpcId: 'probe-1', method: endpoint, payload,
  }))]) as unknown as IncomingMessage
  req.method = options.method ?? 'POST'
  req.url = `${STREAM_SETTINGS_RPC_CHANNEL}/${endpoint}`
  req.headers = options.headers ?? { 'content-type': 'application/json' }
  const state: Exchange = { status: 0, body: '' }
  const res = {
    writeHead(status: number) { state.status = status; return res },
    end(value?: string) { state.body = value ?? '' },
    on() { return res },
  } as unknown as ServerResponse
  await route.handler(req, res)
  return state
}

describe('smooth-stream settings channel fallback', () => {
  it('routes admitted calls to the four-argument handler and withdraws on disposal', async () => {
    const host = await mountHost(true)
    mounted.push(host.dispose)
    const route = host.routes.find(candidate => candidate.path === STREAM_SETTINGS_RPC_CHANNEL) as WebRoute
    const response = await call(route, 'settings.read', { sample: 1 })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      type: 'server-response',
      rpcId: 'probe-1',
      result: {
        ok: true,
        value: {
          endpoint: 'settings.read',
          payload: { sample: 1 },
          aborted: false,
          principal: { kind: 'owner' },
        },
      },
    })
    await host.dispose()
    mounted.pop()
    expect(host.routes).toEqual([])
  })

  it('refuses unadmitted calls and validates HTTP framing', async () => {
    const denied = await mountHost(false)
    mounted.push(denied.dispose)
    const deniedRoute = denied.routes[0] as WebRoute
    expect(await call(deniedRoute, 'settings.read', {}, { headers: {} }))
      .toEqual({ status: 401, body: 'unauthorized' })

    const admitted = await mountHost(true)
    mounted.push(admitted.dispose)
    const route = admitted.routes[0] as WebRoute
    expect((await call(route, 'settings.read', {}, { method: 'GET' })).status).toBe(404)
    expect((await call(route, 'settings.read', {}, { headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await call(route, 'settings.read', {}, { body: 'not json' })).status).toBe(400)
    const mismatch = await call(route, 'settings.read', {}, {
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe-2', method: 'settings.write', payload: {} }),
    })
    expect(JSON.parse(mismatch.body)).toMatchObject({
      rpcId: 'probe-2', result: { ok: false, error: { code: 'gateway/bad-request' } },
    })
    const malformed = await call(route, 'settings.read', {}, { body: JSON.stringify({ rpcId: 7 }) })
    expect(JSON.parse(malformed.body)).toMatchObject({
      rpcId: 'invalid-request', result: { ok: false, error: { code: 'gateway/bad-request' } },
    })
  })

  it('fails closed when admission or the web server is unavailable', async () => {
    const ctx = new Context()
    ctx.provide('connection', { rpc: { handle: () => { throw new Error('offline') } } } as never)
    const fiber = ctx.plugin({
      apply(pluginCtx) {
        const handler: ConnectionRpcHandler = async () => ({ ok: true, value: {} })
        registerSettingsChannel(pluginCtx, STREAM_SETTINGS_RPC_CHANNEL, handler)
      },
    })
    await expect(fiber.await()).rejects.toThrow('webServer is unavailable')
  })
})
