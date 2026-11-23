const UNSAFE_DIRECTION = /[\n\r\u0590-\u08ff\u200e-\u200f\u202a-\u202e\u2066-\u2069\ufb1d-\ufdff\ufe70-\ufeff\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u
const BLOCK_CONTAINERS = new Set(['block', 'inline-block', 'flow-root'])

function presented(element: HTMLElement): boolean {
  let current: HTMLElement | null = element
  while (current !== null) {
    const style = getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
      || style.contentVisibility === 'hidden' || style.opacity === '0') return false
    current = current.parentElement
  }
  return true
}

/** Detect a hidden LTR tail only after the animated prefix itself reaches an ellipsis. */
export function createEllipsisTailProbe(root: HTMLElement): (node: Text, source: string) => boolean {
  const range = (() => {
    try {
      return typeof root.ownerDocument.createRange === 'function' ? root.ownerDocument.createRange() : null
    } catch { return null }
  })()
  if (range === null || typeof range.getBoundingClientRect !== 'function'
    || typeof range.getClientRects !== 'function') return () => false

  return (node, source) => {
    if (node.data === '' || node.data.length >= source.length || !node.isConnected || !root.contains(node)) return false
    const parent = node.parentElement
    if (parent === null) return false
    const textStyle = getComputedStyle(parent)
    // Future bidi runs/newlines or centered/vertical text can move glyphs that
    // are already visible. Keep their original animation rather than guessing.
    if (textStyle.whiteSpace !== 'nowrap' || textStyle.direction === 'rtl'
      || textStyle.visibility === 'hidden' || textStyle.visibility === 'collapse'
      || (textStyle.textAlign !== '' && !['left', 'start', 'initial'].includes(textStyle.textAlign))
      || (textStyle.unicodeBidi !== '' && textStyle.unicodeBidi !== 'normal')
      || (textStyle.writingMode !== '' && textStyle.writingMode !== 'horizontal-tb')
      || UNSAFE_DIRECTION.test(source)) return false

    let element: HTMLElement | null = parent
    while (element !== null && root.contains(element)) {
      const style = element === parent ? textStyle : getComputedStyle(element)
      if (style.position === 'absolute' || style.position === 'fixed'
        || (style.transform !== '' && style.transform !== 'none')) return false
      const ellipsis = style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap'
        && (style.overflowX === 'hidden' || style.overflowX === 'clip')
        && style.direction !== 'rtl' && BLOCK_CONTAINERS.has(style.display)
        && element.scrollLeft === 0
      if (ellipsis) {
        try {
          const clip = element.getBoundingClientRect()
          // Zero/unavailable geometry is not evidence of invisible text.
          if (Number.isFinite(clip.left) && Number.isFinite(clip.right) && Number.isFinite(clip.width)
            && Number.isFinite(clip.height) && clip.width > 0 && clip.height > 0 && element.clientWidth > 0
            && element.scrollWidth > element.clientWidth) {
            range.selectNodeContents(node)
            const prefix = range.getBoundingClientRect()
            const lines = Array.from(range.getClientRects())
            const first = lines[0]
            const singleLine = first !== undefined && lines.every(line => Number.isFinite(line.top)
              && Number.isFinite(line.bottom) && Math.abs(line.top - first.top) <= 1
              && Math.abs(line.bottom - first.bottom) <= 1)
            // Ancestor overflow alone is insufficient: a later sibling can be
            // overflowing while this Text's own prefix is still fully visible.
            if (singleLine && Number.isFinite(prefix.left) && Number.isFinite(prefix.right)
              && Number.isFinite(prefix.width) && Number.isFinite(prefix.height)
              && prefix.width > 0 && prefix.height > 0 && prefix.left < clip.right
              && prefix.right > clip.left && prefix.right > clip.right + 1 && presented(parent)) return true
          }
        } catch { return false }
      }
      // Do not attribute an independent child layout to an ancestor's text line.
      if (style.display === 'flex' || style.display === 'inline-flex' || style.display === 'grid'
        || style.display === 'inline-grid' || (BLOCK_CONTAINERS.has(style.display) && !ellipsis)) return false
      if (element === root) break
      element = element.parentElement
    }
    return false
  }
}
