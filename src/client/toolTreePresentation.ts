/** Source-level admission for the official root/subCalls Tool call tree. */
interface ToolTreeNode {
  readonly source: Record<string, unknown>
  readonly callId: string
  readonly children: readonly ToolTreeNode[]
}

/** Validate the whole shape before projecting; opaque/malformed trees stay untouched. */
function readToolTree(root: unknown): ToolTreeNode | undefined {
  const ancestors = new Set<object>()
  const visit = (value: unknown): ToolTreeNode | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const source = value as Record<string, unknown>
    if (typeof source.callId !== 'string' || source.callId === '' || ancestors.has(source)) return undefined
    // Preparing calls can precede the tree's first subCalls publication.
    if (!Array.isArray(source.subCalls)) {
      return source.phase === 'preparing' && source.subCalls === undefined
        ? { source, callId: source.callId, children: [] }
        : undefined
    }
    ancestors.add(source)
    const children: ToolTreeNode[] = []
    for (const child of source.subCalls) {
      const parsed = visit(child)
      if (parsed === undefined) {
        ancestors.delete(source)
        return undefined
      }
      children.push(parsed)
    }
    ancestors.delete(source)
    return { source, callId: source.callId, children }
  }
  return visit(root)
}

function collectCallIds(node: ToolTreeNode, result: string[]): void {
  result.push(node.callId)
  for (const child of node.children) collectCallIds(child, result)
}

/** Root first, then each subCalls subtree in its existing display order. */
export function toolTreeCallIds(root: unknown): readonly string[] {
  const tree = readToolTree(root)
  if (tree === undefined) return []
  const result: string[] = []
  collectCallIds(tree, result)
  return result
}

/** Includes the root; an unrecognized tree has no safely projectable calls. */
export function countToolTreeCalls(root: unknown): number {
  return toolTreeCallIds(root).length
}

/** Original per-call payloads, keyed by the Host's stable call identity. */
export function toolTreeCallSources(root: unknown): ReadonlyMap<string, Record<string, unknown>> {
  const tree = readToolTree(root)
  const result = new Map<string, Record<string, unknown>>()
  const visit = (node: ToolTreeNode): void => {
    result.set(node.callId, node.source)
    for (const child of node.children) visit(child)
  }
  if (tree !== undefined) visit(tree)
  return result
}

/**
 * Retain admitted identities rather than a numeric prefix: a new grandchild
 * must not evict a sibling whose component and hook state are already visible.
 * Frozen payload overrides affect only the call itself; children still follow
 * the live source hierarchy and their independent admission identities.
 */
export function projectToolTreeCallIds<T>(root: T, visible: ReadonlySet<string>,
  frozen?: ReadonlyMap<string, Record<string, unknown>>): T {
  const tree = readToolTree(root)
  if (tree === undefined) return root
  const project = (node: ToolTreeNode): Record<string, unknown> => {
    const source = frozen?.get(node.callId) ?? node.source
    const children = node.children.filter(child => visible.has(child.callId)).map(project)
    const original = source.subCalls
    if (original === undefined && children.length === 0) return source
    return Array.isArray(original) && children.length === original.length
      && children.every((child, index) => child === original[index])
      ? source : { ...source, subCalls: children }
  }
  return project(tree) as T
}

/**
 * Retain a preorder prefix without mutating source data or touching presentation
 * metadata. The root is always admitted, including for a zero/invalid budget.
 * Unknown shapes are returned unchanged; complete subtrees reuse their identity.
 */
export function projectToolTreeCalls<T>(root: T, visibleCallCount: number): T {
  const tree = readToolTree(root)
  if (tree === undefined) return root
  let remaining = Number.isNaN(visibleCallCount) ? 1 : Math.max(1, Math.floor(visibleCallCount))
  const project = (node: ToolTreeNode): Record<string, unknown> => {
    remaining--
    if (node.children.length === 0) return node.source
    const children: Record<string, unknown>[] = []
    for (const child of node.children) {
      if (remaining <= 0) break
      children.push(project(child))
    }
    const unchanged = children.length === node.children.length
      && children.every((child, index) => child === node.children[index]!.source)
    return unchanged ? node.source : { ...node.source, subCalls: children }
  }
  return project(tree) as T
}
