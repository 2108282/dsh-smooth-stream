type UnknownRecord = Record<PropertyKey, unknown>
type Enabled = () => boolean

interface MethodPatch {
  readonly target: UnknownRecord
  readonly key: string
  readonly original: Function
  readonly installed: Function
  readonly descriptor: PropertyDescriptor | undefined
}

interface Pipeline {
  readonly checks: Set<Enabled>
  readonly bindings: Set<BindingPatch>
  bindingMethod: MethodPatch | undefined
}

interface PendingFrame {
  readonly id: number
  readonly args: unknown[]
}

interface BindingPatch {
  readonly binding: UnknownRecord
  readonly method: MethodPatch
  readonly owners: Set<Pipeline>
  pending: PendingFrame | undefined
}

const pipelines = new WeakMap<UnknownRecord, Pipeline>()
const patchedBindings = new WeakMap<UnknownRecord, BindingPatch>()

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return isRecord(value) && typeof value[Symbol.iterator] === 'function'
}

function readBindings(service: UnknownRecord): unknown[] {
  const bindings = service.bindings
  if (!isRecord(bindings)) return []
  try {
    const values = bindings.values
    const records: unknown = typeof values === 'function' ? Reflect.apply(values, bindings, []) : values
    return isIterable(records) ? Array.from(records) : []
  } catch {
    // Unknown or unavailable registries must not prevent wrapping future bindings.
    return []
  }
}

function installMethod(target: UnknownRecord, key: string, installed: Function): MethodPatch | undefined {
  const original = target[key]
  if (typeof original !== 'function') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  try {
    Object.defineProperty(target, key, {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? false,
      writable: true,
      value: installed,
    })
  } catch {
    return undefined
  }
  return { target, key, original, installed, descriptor }
}

function restoreMethod(method: MethodPatch): void {
  if (method.target[method.key] !== method.installed) return
  if (method.descriptor) Object.defineProperty(method.target, method.key, method.descriptor)
  else delete method.target[method.key]
}

function isEnabled(patch: BindingPatch): boolean {
  for (const owner of patch.owners) {
    for (const enabled of owner.checks) {
      if (enabled()) return true
    }
  }
  return false
}

function patchBinding(pipeline: Pipeline, value: unknown): void {
  if (!isRecord(value) || typeof value.publish !== 'function' || typeof value.flush !== 'function') return
  let patch = patchedBindings.get(value)
  if (!patch) {
    const original = value.publish
    let current: BindingPatch | undefined
    const installed = function (this: unknown, ...args: unknown[]): unknown {
      if (this !== value || !current || current.owners.size === 0 || args[0] !== 'animation-frame'
        || !isEnabled(current) || typeof requestAnimationFrame !== 'function') {
        return Reflect.apply(original, this, args)
      }
      if (value.frame !== undefined) return undefined
      const pending: PendingFrame = {
        id: requestAnimationFrame(() => {
          if (!current || current.pending !== pending || value.frame !== pending.id) return
          current.pending = undefined
          value.frame = undefined
          if (!isEnabled(current)) {
            Reflect.apply(original, value, pending.args)
            return
          }
          const flush = value.flush
          if (typeof flush === 'function') Reflect.apply(flush, value, [])
        }),
        args,
      }
      current.pending = pending
      value.frame = pending.id
      return undefined
    }
    const method = installMethod(value, 'publish', installed)
    if (!method) return
    patch = { binding: value, method, owners: new Set(), pending: undefined }
    current = patch
    patchedBindings.set(value, patch)
  }
  patch.owners.add(pipeline)
  pipeline.bindings.add(patch)
}

/**
 * Optimize only animation-frame publications; all other publications stay with DSH.
 * Pass a live enabled && fastPipeline predicate and return this cleanup from ctx.inject.
 */
export function installConversationPipeline(service: unknown, enabled: Enabled): () => void {
  if (!isRecord(service)) return () => {}
  let pipeline = pipelines.get(service)
  if (!pipeline) {
    pipeline = { checks: new Set(), bindings: new Set(), bindingMethod: undefined }
    pipelines.set(service, pipeline)
    const owner = pipeline
    const original = service.binding
    if (typeof original === 'function') {
      const installed = function (this: unknown, ...args: unknown[]): unknown {
        const binding: unknown = Reflect.apply(original, this, args)
        if (owner.checks.size > 0) patchBinding(owner, binding)
        return binding
      }
      pipeline.bindingMethod = installMethod(service, 'binding', installed)
    }
  }
  // A distinct lease makes duplicate installs with the same predicate independently disposable.
  const lease = (): boolean => enabled()
  pipeline.checks.add(lease)
  for (const record of readBindings(service)) {
    if (isRecord(record)) patchBinding(pipeline, record.binding)
  }
  const owner = pipeline
  let active = true
  return () => {
    if (!active) return
    active = false
    owner.checks.delete(lease)
    if (owner.checks.size > 0) return
    if (owner.bindingMethod) restoreMethod(owner.bindingMethod)
    pipelines.delete(service)
    for (const patch of owner.bindings) {
      patch.owners.delete(owner)
      if (patch.owners.size > 0) continue
      const pending = patch.pending
      patch.pending = undefined
      restoreMethod(patch.method)
      patchedBindings.delete(patch.binding)
      // Hand an unfinished publication back to DSH instead of dropping its assembler work.
      if (pending && patch.binding.frame === pending.id) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pending.id)
        patch.binding.frame = undefined
        Reflect.apply(patch.method.original, patch.binding, pending.args)
      }
    }
    owner.bindings.clear()
  }
}
