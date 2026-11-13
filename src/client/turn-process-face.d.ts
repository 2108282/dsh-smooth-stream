/**
 * Minimal fold face accepted by the legacy standalone assistant renderer.
 *
 * DSH 0.2.2 owns the complete turnProcess contract in ui-chat. Standalone
 * reproductions and legacy tests only provide these fold fields, so keep
 * this local face separate from the official ChatNodeOwnerProps interface.
 */
export interface TurnProcessOwnerFace {
  /** Answer anchor of the projection; null while the answer has not landed. */
  readonly spec: { readonly answerStep: number | null, readonly inlineReasoning: boolean }
  /** Whether this node's process content may fold (turn closed + compact mode). */
  readonly foldable: boolean
  /** Current fold state, persisted by the Host across sessions. */
  readonly open: boolean
  /** Fold or unfold from the renderer side (summary click, find-in-page reveal). */
  setOpen(open: boolean): void
}
