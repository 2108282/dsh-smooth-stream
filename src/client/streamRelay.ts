type Listener = () => void

interface TurnRelayState {
  reasoningActive: boolean
  textActive: boolean
}

/**
 * Universal Baton Relay Queue for DSH Smooth Stream.
 * Guarantees strict sequential execution across all Agent loop iterations:
 * Phase 1: Reasoning stream -> Phase 2: Text response stream -> Phase 3: Tool execution.
 * Only ONE active animator exists at any given instant.
 */
class StreamRelay {
  private readonly turns = new Map<string, TurnRelayState>()
  private readonly listeners = new Set<Listener>()

  private getOrCreate(turnKey: string): TurnRelayState {
    let state = this.turns.get(turnKey)
    if (!state) {
      state = { reasoningActive: false, textActive: false }
      this.turns.set(turnKey, state)
    }
    return state
  }

  setReasoningActive(turnKey: string, active: boolean): void {
    const key = turnKey || 'active'
    const state = this.getOrCreate(key)
    if (state.reasoningActive === active) return
    state.reasoningActive = active
    this.notify()
  }

  setTextActive(turnKey: string, active: boolean): void {
    const key = turnKey || 'active'
    const state = this.getOrCreate(key)
    if (state.textActive === active) return
    state.textActive = active
    this.notify()
  }

  isReasoningActive(turnKey?: string | null): boolean {
    if (turnKey) {
      const state = this.turns.get(turnKey)
      if (state?.reasoningActive) return true
    }
    for (const state of this.turns.values()) {
      if (state.reasoningActive) return true
    }
    return false
  }

  isTextActive(turnKey?: string | null): boolean {
    if (turnKey) {
      const state = this.turns.get(turnKey)
      if (state?.textActive) return true
    }
    for (const state of this.turns.values()) {
      if (state.textActive) return true
    }
    return false
  }

  /**
   * Whether a tool call in this step/turn must wait.
   * Blocked as long as any preceding reasoning or text is still revealing.
   */
  isToolBlocked(turnKey?: string | null): boolean {
    return this.isReasoningActive(turnKey) || this.isTextActive(turnKey)
  }

  subscribe = (listener: Listener): () => void => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener()
    }
  }
}

export const streamRelay = new StreamRelay()
