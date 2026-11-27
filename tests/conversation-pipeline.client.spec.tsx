import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installConversationPipeline } from '../src/client/conversationPipeline.ts'

type Publication = 'none' | 'immediate' | 'animation-frame'

/** Match the installed BoundConversation publication and cancellation semantics. */
class Binding {
  frame: number | undefined
  readonly publications: Publication[] = []
  readonly flush = vi.fn()

  publish(publication: Publication): void {
    this.publications.push(publication)
    if (publication === 'none') return
    if (publication === 'animation-frame' && typeof requestAnimationFrame === 'function') {
      if (this.frame !== undefined) return
      this.frame = requestAnimationFrame(() => {
        this.frame = requestAnimationFrame(() => {
          this.frame = requestAnimationFrame(() => {
            this.frame = undefined
            this.flush()
          })
        })
      })
      return
    }
    this.cancelFrame()
    this.flush()
  }

  cancelFrame(): void {
    if (this.frame !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.frame)
    }
    this.frame = undefined
  }

  dispose(): void {
    this.cancelFrame()
  }
}

function createService(existing: Binding[] = [], form: 'set' | 'function' = 'set') {
  const records = new Map(existing.map((binding, index) => [`existing-${index}`, { binding }]))
  const values = new Set(records.values())
  const service = {
    bindings: form === 'set' ? { values } : records,
    binding(id: string): Binding {
      let record = records.get(id)
      if (!record) {
        record = { binding: new Binding() }
        records.set(id, record)
        values.add(record)
      }
      return record.binding
    },
  }
  return service
}

let frames: Map<number, FrameRequestCallback>
let nextFrame: number
const cleanups: (() => void)[] = []

function install(service: unknown, enabled: () => boolean = () => true): () => void {
  const cleanup = installConversationPipeline(service, enabled)
  cleanups.push(cleanup)
  return cleanup
}

function paint(): void {
  const batch = [...frames.values()]
  frames.clear()
  for (const callback of batch) callback(0)
}

beforeEach(() => {
  frames = new Map()
  nextFrame = 1
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id) }))
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.unstubAllGlobals()
})

describe('installConversationPipeline', () => {
  it.each(['set', 'function'] as const)('optimizes every existing binding from %s values in one frame', (form) => {
    const first = new Binding()
    const second = new Binding()
    const outside = new Binding()
    install(createService([first, second], form))

    first.publish('animation-frame')
    first.publish('animation-frame')
    second.publish('animation-frame')
    outside.publish('animation-frame')
    expect(frames.size).toBe(3)
    paint()
    expect(first.flush).toHaveBeenCalledTimes(1)
    expect(second.flush).toHaveBeenCalledTimes(1)
    expect(outside.flush).not.toHaveBeenCalled()
    paint()
    paint()
    expect(outside.flush).toHaveBeenCalledTimes(1)
  })

  it('wraps future binding resolutions, preserving receiver, arguments and stable identity', () => {
    const service = createService()
    const original = service.binding
    const spy = vi.spyOn(service, 'binding')
    install(service)
    const first = service.binding('new')
    expect(spy).toHaveBeenCalledExactlyOnceWith('new')
    expect(spy.mock.contexts[0]).toBe(service)
    expect(service.binding('new')).toBe(first)
    expect(original.call(service, 'new')).toBe(first)
    first.publish('animation-frame')
    paint()
    expect(first.flush).toHaveBeenCalledTimes(1)
  })

  it('keeps none and immediate on the original path, including cancelling a pending fast frame', () => {
    const binding = new Binding()
    install(createService([binding]))
    binding.publish('none')
    expect(binding.publications).toEqual(['none'])
    expect(frames.size).toBe(0)
    expect(binding.flush).not.toHaveBeenCalled()

    binding.publish('animation-frame')
    const pending = binding.frame
    binding.publish('none')
    expect(binding.frame).toBe(pending)
    expect(frames.size).toBe(1)
    binding.publish('immediate')
    expect(binding.publications).toEqual(['none', 'none', 'immediate'])
    expect(cancelAnimationFrame).toHaveBeenCalledWith(pending)
    expect(frames.size).toBe(0)
    expect(binding.flush).toHaveBeenCalledTimes(1)
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(1)
  })

  it('preserves pending assembler work when ignorable publications report none', () => {
    const binding = new Binding()
    let dirty = false
    const delivered: string[] = []
    binding.flush.mockImplementation(() => {
      if (dirty) delivered.push('stream update')
      dirty = false
    })
    install(createService([binding]))
    dirty = true
    binding.publish('animation-frame')
    binding.publish('none')
    paint()
    expect(delivered).toEqual(['stream update'])
    expect(binding.publications).toEqual(['none'])
  })

  it('uses the current enabled and fastPipeline flags on every publication', () => {
    const binding = new Binding()
    const flags = { enabled: false, fastPipeline: true }
    install(createService([binding]), () => flags.enabled && flags.fastPipeline)
    binding.publish('animation-frame')
    paint()
    paint()
    expect(binding.flush).not.toHaveBeenCalled()
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(1)

    flags.enabled = true
    binding.publish('animation-frame')
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(2)
    flags.fastPipeline = false
    binding.publish('animation-frame')
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(2)
    paint()
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(3)
  })

  it('hands a pending fast publication back to the original path when flags turn off', () => {
    const binding = new Binding()
    let enabled = true
    install(createService([binding]), () => enabled)
    binding.publish('animation-frame')
    enabled = false
    paint()
    expect(binding.publications).toEqual(['animation-frame'])
    expect(binding.flush).not.toHaveBeenCalled()
    paint()
    paint()
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(1)
  })

  it('preserves an original three-frame publication already scheduled before installation', () => {
    const binding = new Binding()
    binding.publish('animation-frame')
    const frame = binding.frame
    install(createService([binding]))
    binding.publish('animation-frame')
    expect(binding.frame).toBe(frame)
    expect(frames.size).toBe(1)
    paint()
    paint()
    expect(binding.flush).not.toHaveBeenCalled()
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(1)
  })

  it('falls back to the original method when rAF is unavailable', () => {
    const binding = new Binding()
    install(createService([binding]))
    vi.stubGlobal('requestAnimationFrame', undefined)
    binding.publish('animation-frame')
    expect(binding.publications).toEqual(['animation-frame'])
    expect(binding.flush).toHaveBeenCalledTimes(1)
  })

  it('restores inherited methods and tolerates repeated cleanup', () => {
    const binding = new Binding()
    const service = createService([binding])
    const originalPublish = binding.publish
    const originalBinding = service.binding
    const cleanup = install(service)
    expect(binding.publish).not.toBe(originalPublish)
    expect(service.binding).not.toBe(originalBinding)
    cleanup()
    cleanup()
    expect(service.binding).toBe(originalBinding)
    expect(binding.publish).toBe(originalPublish)
    expect(Object.hasOwn(binding, 'publish')).toBe(false)
    const future = service.binding('after-cleanup')
    expect(future.publish).toBe(originalPublish)
    binding.publish('animation-frame')
    paint()
    expect(binding.flush).not.toHaveBeenCalled()
    paint()
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(1)
  })

  it('restores service methods inherited from a prototype without leaving an own property', () => {
    class Service {
      binding(): Binding { return new Binding() }
    }
    const service = new Service()
    const original = service.binding
    const cleanup = install(service)
    expect(Object.hasOwn(service, 'binding')).toBe(true)
    cleanup()
    expect(service.binding).toBe(original)
    expect(Object.hasOwn(service, 'binding')).toBe(false)
  })

  it('optimizes plain-object bindings and restores their original own method descriptor', () => {
    const binding = {
      frame: undefined as number | undefined,
      flush: vi.fn(),
      publish: vi.fn(),
    }
    const descriptor = Object.getOwnPropertyDescriptor(binding, 'publish')
    const cleanup = install({ bindings: { values: new Set([{ binding }]) } })
    binding.publish('animation-frame')
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(1)
    cleanup()
    expect(Object.getOwnPropertyDescriptor(binding, 'publish')).toEqual(descriptor)
  })

  it('does not stack wrappers on duplicate installs and cleans up each lease separately', () => {
    const binding = new Binding()
    const service = createService([binding])
    const enabled = () => true
    const originalPublish = binding.publish
    const originalBinding = service.binding
    const first = install(service, enabled)
    const publish = binding.publish
    const resolve = service.binding
    const second = install(service, enabled)
    expect(binding.publish).toBe(publish)
    expect(service.binding).toBe(resolve)
    first()
    expect(binding.publish).toBe(publish)
    binding.publish('animation-frame')
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(1)
    second()
    expect(binding.publish).toBe(originalPublish)
    expect(service.binding).toBe(originalBinding)
  })

  it('supports a binding shared by services with independent lifetimes and enabled predicates', () => {
    const binding = new Binding()
    const original = binding.publish
    const first = install(createService([binding]), () => false)
    const second = install(createService([binding]))
    first()
    binding.publish('animation-frame')
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(1)
    second()
    expect(binding.publish).toBe(original)
  })

  it('returns queued work to the original method and makes stale optimized callbacks inert on uninstall', () => {
    const binding = new Binding()
    const cleanup = install(createService([binding]))
    binding.publish('animation-frame')
    const stale = [...frames.values()][0]
    const fastFrame = binding.frame
    cleanup()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(fastFrame)
    expect(binding.publications).toEqual(['animation-frame'])
    stale?.(0)
    expect(binding.flush).not.toHaveBeenCalled()
    paint()
    paint()
    expect(binding.flush).not.toHaveBeenCalled()
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(1)
  })

  it('does not resurrect work cancelled by binding disposal', () => {
    const binding = new Binding()
    const cleanup = install(createService([binding]))
    binding.publish('animation-frame')
    const stale = [...frames.values()][0]
    binding.dispose()
    cleanup()
    stale?.(0)
    paint()
    expect(frames.size).toBe(0)
    expect(binding.flush).not.toHaveBeenCalled()
    expect(binding.publications).toEqual([])
  })

  it('preserves later method replacements and prevents saved wrappers from patching after uninstall', () => {
    const binding = new Binding()
    const service = createService([binding])
    const originalPublish = binding.publish
    const cleanup = install(service)
    const oldBindingWrapper = service.binding
    const oldPublishWrapper = binding.publish
    const replacementBinding = vi.fn(() => new Binding())
    const replacementPublish = vi.fn()
    service.binding = replacementBinding
    binding.publish = replacementPublish
    cleanup()
    expect(service.binding).toBe(replacementBinding)
    expect(binding.publish).toBe(replacementPublish)
    const future = oldBindingWrapper.call(service, 'saved-wrapper')
    expect(future.publish).toBe(originalPublish)
    oldPublishWrapper.call(binding, 'animation-frame')
    paint()
    expect(binding.flush).not.toHaveBeenCalled()
    paint()
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(1)
  })

  it('can install again after cleanup without reviving an old installation', () => {
    const binding = new Binding()
    const service = createService([binding])
    const first = install(service)
    const staleResolve = service.binding
    const stalePublish = binding.publish
    first()
    const second = install(service)
    expect(service.binding).not.toBe(staleResolve)
    expect(binding.publish).not.toBe(stalePublish)
    binding.publish('animation-frame')
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(1)
    first()
    second()
    expect(Object.hasOwn(binding, 'publish')).toBe(false)
  })

  it('ignores incompatible values without preventing future bindings', () => {
    expect(() => install(undefined)()).not.toThrow()
    expect(() => install({})()).not.toThrow()
    expect(() => install({ bindings: { values: 123 } })()).not.toThrow()
    const service = {
      bindings: { values: () => { throw new Error('unsupported registry') } },
      binding: () => new Binding(),
    }
    install(service)
    const binding = service.binding()
    binding.publish('animation-frame')
    paint()
    expect(binding.flush).toHaveBeenCalledTimes(1)
  })
})
