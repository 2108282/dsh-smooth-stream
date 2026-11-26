import { describe, expect, it } from 'vitest'
import { countToolTreeCalls, projectToolTreeCalls, projectToolTreeCallIds, toolTreeCallIds, toolTreeCallSources } from '../src/client/toolTreePresentation.ts'

interface Call {
  readonly callId: string
  readonly subCalls: readonly Call[]
}

function call(callId: string, subCalls: readonly Call[] = []): Call {
  return Object.freeze({ callId, subCalls: Object.freeze([...subCalls]) })
}

function fixture() {
  const first = call('first', [call('first-a'), call('first-b')])
  const second = call('second', [call('second-a')])
  return call('root', [first, second])
}

describe('Tool tree source presentation', () => {
  it('lists and counts the official root-first recursive display order', () => {
    const root = fixture()
    expect(toolTreeCallIds(root)).toEqual(['root', 'first', 'first-a', 'first-b', 'second', 'second-a'])
    expect(countToolTreeCalls(root)).toBe(6)
  })

  it('retains admitted identities when a new earlier grandchild is still queued', () => {
    const stable = call('stable')
    const earlier = call('earlier', [call('new')])
    const root = call('root', [earlier, stable])
    const projection = projectToolTreeCallIds(root, new Set(['root', 'earlier', 'stable']))
    expect(toolTreeCallIds(projection)).toEqual(['root', 'earlier', 'stable'])
    expect(projection.subCalls[1]).toBe(stable)
    expect(projection.subCalls[0]!.subCalls).toEqual([])
    expect(root.subCalls[0]!.subCalls).toHaveLength(1)
    expect(projectToolTreeCallIds(root, new Set(toolTreeCallIds(root)))).toBe(root)
  })

  it('projects frozen call payloads while retaining independently admitted children', () => {
    const frozen = { ...call('child'), text: 'old', result: { value: 'old' } }
    const later = call('later')
    const child = { ...frozen, text: 'old-new', subCalls: [later] }
    const root = call('root', [child])
    const sources = toolTreeCallSources(root)
    expect(sources.get('child')).toBe(child)
    const projection = projectToolTreeCallIds(root, new Set(['root', 'child', 'later']), new Map([['child', frozen]]))
    expect(projection.subCalls[0]).toMatchObject({ text: 'old', result: frozen.result })
    expect(projection.subCalls[0]!.subCalls[0]).toBe(later)
    expect(root.subCalls[0]).toBe(child)
    expect(toolTreeCallSources({ root }).size).toBe(0)
  })

  it('admits exactly one further call for every increased preorder budget', () => {
    const root = fixture()
    const ids = toolTreeCallIds(root)
    for (let visible = 1; visible <= ids.length; visible++) {
      const projection = projectToolTreeCalls(root, visible)
      expect(toolTreeCallIds(projection)).toEqual(ids.slice(0, visible))
      expect(countToolTreeCalls(projection)).toBe(visible)
    }
  })

  it('keeps the root for zero, negative, fractional, and invalid budgets', () => {
    const root = fixture()
    for (const budget of [0, -1, Number.NEGATIVE_INFINITY, Number.NaN, 1.9]) {
      expect(toolTreeCallIds(projectToolTreeCalls(root, budget))).toEqual(['root'])
    }
    expect(toolTreeCallIds(projectToolTreeCalls(root, 2.9))).toEqual(['root', 'first'])
  })

  it('returns the exact source for a full, excessive, or infinite budget', () => {
    const root = fixture()
    for (const budget of [6, 99, Number.POSITIVE_INFINITY]) {
      expect(projectToolTreeCalls(root, budget)).toBe(root)
    }
  })

  it('clones only changed ancestors and preserves complete child subtrees', () => {
    const root = fixture()
    const projection = projectToolTreeCalls(root, 5)
    expect(projection).not.toBe(root)
    expect(projection.subCalls).not.toBe(root.subCalls)
    expect(projection.subCalls[0]).toBe(root.subCalls[0])
    expect(projection.subCalls[1]).not.toBe(root.subCalls[1])
    expect(projection.subCalls[1]?.subCalls).toEqual([])
    expect(root.subCalls[1]?.subCalls).toHaveLength(1)
    expect(toolTreeCallIds(root)).toHaveLength(6)
  })

  it('preserves the generic root type and all non-tree metadata by reference', () => {
    const root = Object.freeze({
      ...fixture(),
      kind: 'tool-result' as const,
      state: 'error' as const,
      meta: Object.freeze({ autoReviewDenied: true }),
      children: Object.freeze([{ icon: 'svg', title: 'opaque content' }]),
      content: Object.freeze([{ type: 'text', text: 'result' }]),
      call: Object.freeze({ name: 'unknown/plugin-tool', argsRaw: '{}' }),
      renderFallback: () => 'official fallback',
    })
    const projected: typeof root = projectToolTreeCalls(root, 2)
    expect(projected.kind).toBe('tool-result')
    expect(projected.state).toBe('error')
    expect(projected.meta).toBe(root.meta)
    expect(projected.children).toBe(root.children)
    expect(projected.content).toBe(root.content)
    expect(projected.call).toBe(root.call)
    expect(projected.renderFallback).toBe(root.renderFallback)
    expect(projected.renderFallback()).toBe('official fallback')
    expect(toolTreeCallIds(projected)).toEqual(['root', 'first'])
  })

  it('accepts a preparing root without subCalls and never manufactures children', () => {
    const root = Object.freeze({ callId: 'preparing', phase: 'preparing' as const, name: 'tool', args: {} })
    expect(toolTreeCallIds(root)).toEqual(['preparing'])
    expect(countToolTreeCalls(root)).toBe(1)
    expect(projectToolTreeCalls(root, 0)).toBe(root)
    expect(projectToolTreeCalls(root, 10)).toBe(root)
    expect('subCalls' in root).toBe(false)
  })

  it('accepts preparing leaves inside a started or completed tree', () => {
    const preparing = Object.freeze({ callId: 'child', phase: 'preparing' as const })
    const root = Object.freeze({ kind: 'tool-result', callId: 'done', subCalls: Object.freeze([preparing]) })
    expect(countToolTreeCalls(root)).toBe(2)
    expect(projectToolTreeCalls(root, 1).subCalls).toEqual([])
    expect(projectToolTreeCalls(root, 2)).toBe(root)
  })

  it('recognizes unknown business kinds from their tree shape without changing payloads', () => {
    const root = {
      kind: 'plugin-specific-result',
      callId: 'custom',
      payload: { anything: true },
      subCalls: [{ kind: 'another-kind', callId: 'child', payload: ['raw'], subCalls: [] }],
    }
    const projection = projectToolTreeCalls(root, 1)
    expect(countToolTreeCalls(root)).toBe(2)
    expect(projection.kind).toBe(root.kind)
    expect(projection.payload).toBe(root.payload)
    expect(projection.subCalls).toEqual([])
  })

  it.each([
    null,
    undefined,
    7,
    'opaque',
    [],
    {},
    { root: call('wrapped') },
    { callId: 'missing-children' },
    { callId: '', subCalls: [] },
    { callId: 7, subCalls: [] },
    { callId: 'malformed', subCalls: null },
    { callId: 'malformed', subCalls: {} },
    { callId: 'malformed', subCalls: [{ unknown: true }] },
    { callId: 'malformed', subCalls: [call('valid'), null] },
  ])('leaves an unrecognized structure unchanged: %j', root => {
    expect(toolTreeCallIds(root)).toEqual([])
    expect(countToolTreeCalls(root)).toBe(0)
    expect(projectToolTreeCalls(root, 1)).toBe(root)
    expect(projectToolTreeCalls(root, 100)).toBe(root)
  })

  it('rejects cyclic structures without mutating or partially projecting them', () => {
    const root: { callId: string; subCalls: unknown[] } = { callId: 'cycle', subCalls: [] }
    root.subCalls.push(root)
    expect(toolTreeCallIds(root)).toEqual([])
    expect(countToolTreeCalls(root)).toBe(0)
    expect(projectToolTreeCalls(root, 1)).toBe(root)
    expect(root.subCalls[0]).toBe(root)
  })

  it('preserves repeated source occurrences instead of deduplicating or reordering children', () => {
    const shared = call('shared')
    const root = call('root', [shared, shared])
    expect(toolTreeCallIds(root)).toEqual(['root', 'shared', 'shared'])
    expect(projectToolTreeCalls(root, 2).subCalls).toEqual([shared])
    expect(projectToolTreeCalls(root, 3)).toBe(root)
  })

  it('accepts a new source suffix without modifying the earlier source snapshot', () => {
    const first = call('first')
    const original = call('root', [first])
    const updated = call('root', [first, call('new')])
    const projection = projectToolTreeCalls(updated, countToolTreeCalls(original))
    expect(toolTreeCallIds(projection)).toEqual(toolTreeCallIds(original))
    expect(projection.subCalls[0]).toBe(first)
    expect(original.subCalls).toHaveLength(1)
    expect(updated.subCalls).toHaveLength(2)
    expect(projectToolTreeCalls(updated, 3)).toBe(updated)
  })
})
