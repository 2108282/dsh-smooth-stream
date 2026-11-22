import { describe, expect, it } from 'vitest'
import { PresentationProgress } from '../src/client/presentationProgress.ts'

describe('bounded committed presentation progress', () => {
  it('restores only matching prefixes and keeps sessions independent', () => {
    const progress = new PresentationProgress()
    progress.remember('session-a:reply', 'shown😀')
    expect(progress.read('session-a:reply', 'shown😀 appended')).toBe('shown😀')
    expect(progress.read('session-b:reply', 'shown😀 appended')).toBeUndefined()
    expect(progress.read('session-a:reply', 'rewritten')).toBeUndefined()
    progress.clear()
    expect(progress.read('session-a:reply', 'shown😀')).toBeUndefined()
  })

  it('bounds both retained characters and entry count', () => {
    const progress = new PresentationProgress(2, 8)
    progress.remember('a', '123')
    progress.remember('b', '456')
    progress.remember('c', '789')
    expect(progress.read('a', '123')).toBeUndefined()
    expect(progress.read('b', '456')).toBe('456')
    progress.remember('b', '123456789')
    expect(progress.read('b', '123456789')).toBeUndefined()
    expect(progress.read('c', '789')).toBe('789')
    progress.remember('d', '')
    progress.remember('e', '')
    expect(progress.read('c', '789')).toBeUndefined()
  })
})
