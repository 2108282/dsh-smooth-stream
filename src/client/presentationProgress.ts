/** Bounded, derived presentation progress. No session content is persisted here. */
export class PresentationProgress {
  private readonly entries = new Map<string, string>()
  private size = 0

  constructor(private readonly maxEntries = 512, private readonly maxChars = 1_000_000) {}

  read(key: string, source: string): string | undefined {
    const shown = this.entries.get(key)
    // Rewrites/rewinds cannot reuse a prefix from a different source revision.
    return shown !== undefined && source.startsWith(shown) ? shown : undefined
  }

  remember(key: string, shown: string): void {
    const previous = this.entries.get(key)
    if (previous === shown) return
    if (previous !== undefined) this.size -= previous.length
    this.entries.delete(key)
    if (shown.length > this.maxChars) return
    this.entries.set(key, shown)
    this.size += shown.length
    while (this.entries.size > this.maxEntries || this.size > this.maxChars) {
      const oldest = this.entries.entries().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest[0])
      this.size -= oldest[1].length
    }
  }

  clear(): void {
    this.entries.clear()
    this.size = 0
  }
}

export const assistantProgress = new PresentationProgress()
