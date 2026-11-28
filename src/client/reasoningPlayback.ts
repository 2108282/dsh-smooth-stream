/** Visible reasoning summaries mirror the native ReasoningRow paragraph policy. */
export interface ReasoningSummary {
  text: string
  /** Source paragraph offset: replacing a preview starts a new visible generation. */
  paragraph: number
}

export function visibleReasoningText(raw: string): string {
  const opening = '<signature>'
  if (raw !== '' && opening.startsWith(raw)) return ''
  if (!raw.startsWith(opening)) return raw
  const end = raw.indexOf('</signature>', opening.length)
  return end === -1 ? '' : raw.slice(end + '</signature>'.length).replace(/^(?:\r?\n)+/, '')
}

export function reasoningSummary(raw: string, running: boolean): ReasoningSummary {
  const text = visibleReasoningText(raw)
  if (!running) {
    const newline = text.indexOf('\n')
    return { text: (newline === -1 ? text : text.slice(0, newline)).replaceAll('**', ''), paragraph: 0 }
  }
  let result: ReasoningSummary = { text: '', paragraph: 0 }
  let start = 0
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g
  while (true) {
    const next = separator.exec(text)
    const end = next === null ? text.length : next.index + next[0].indexOf('\n')
    const newline = text.indexOf('\n', start)
    if (newline !== -1 && newline <= end) {
      const first = text.slice(start, newline).trim()
      if (first !== '') result = { text: first.replaceAll('**', ''), paragraph: start }
    }
    if (next === null) return result
    start = next.index + next[0].length
  }
}

/**
 * ReasoningRow owns the native header and disclosure. Its running preview waits
 * for a newline, so feed only the paced summary plus that terminator while the
 * body is collapsed. The full raw text remains available through the Body Slot.
 * A source character without a newline keeps an empty-preview row mounted.
 */
export function reasoningPreviewProjection(summary: string, raw: string): string {
  return summary !== '' ? `${summary}\n` : (visibleReasoningText(raw).trim().slice(0, 1) || '')
}
