import { describe, expect, it } from 'vitest'
import { reasoningPreviewProjection, reasoningSummary, visibleReasoningText } from '../src/client/reasoningPlayback.ts'

describe('native reasoning preview playback', () => {
  it('waits for completed first lines and strips bold markers from summaries only', () => {
    expect(reasoningSummary('**Planning', true)).toEqual({ text: '', paragraph: 0 })
    expect(reasoningSummary('**Planning**\n\nSome prose', true)).toEqual({ text: 'Planning', paragraph: 0 })
    expect(visibleReasoningText('**Planning**\n\nSome prose')).toBe('**Planning**\n\nSome prose')
  })

  it('identifies later paragraphs so replacement summaries have a new playback generation', () => {
    const first = '**First**\n\n'
    expect(reasoningSummary(`${first}**Second`, true)).toEqual({ text: 'First', paragraph: 0 })
    expect(reasoningSummary(`${first}**Second**\nmore`, true)).toEqual({ text: 'Second', paragraph: first.length })
    expect(reasoningSummary(`${first}**Second**\nmore`, false)).toEqual({ text: 'First', paragraph: 0 })
  })

  it('keeps signature metadata out of both body and preview', () => {
    expect(visibleReasoningText('<sign')).toBe('')
    expect(visibleReasoningText('<signature>secret')).toBe('')
    expect(reasoningSummary('<signature>secret</signature>\r\n\r\n**Visible**\n', true).text).toBe('Visible')
  })

  it('lets the native completed-line renderer display every paced summary prefix', () => {
    for (const text of ['P', 'Pl', 'Plan', 'Planning']) {
      const projected = reasoningPreviewProjection(text, '**Planning**\n\nBody')
      expect(reasoningSummary(projected, true).text).toBe(text)
    }
    const noPreview = reasoningPreviewProjection('', '**Planning')
    expect(noPreview.trim()).not.toBe('')
    expect(reasoningSummary(noPreview, true).text).toBe('')
  })
})
