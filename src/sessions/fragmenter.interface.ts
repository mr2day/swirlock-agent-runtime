/**
 * Forward-looking hook for the Fragmenter — the future memory
 * subsystem that consumes accumulating summary blocks and produces
 * longer-term artefacts (per-entity recall, per-topic memory,
 * learned user preferences, episodic vs semantic separation).
 *
 * Not yet implemented. The compactor calls onSummaryCreated after
 * every successful compaction; the no-op implementation registered
 * in SessionsModule simply logs and returns. A future Fragmenter
 * service is a drop-in replacement at the DI binding — no other
 * code needs to change when it ships.
 *
 * Keeping this as an interface (rather than a service shipped with
 * empty methods) lets the eventual implementation own its own
 * lifecycle, state, and storage shape without inheriting accidental
 * scaffolding from the stub.
 */
export interface Fragmenter {
  /**
   * Called after a summary block is successfully persisted. Receives
   * the new summary's metadata. The Fragmenter may read the
   * original messages from `messages` (seq ∈ [startSeq, endSeq])
   * to do its own extraction work; it should NOT mutate the
   * summary or block the compactor's return.
   *
   * Implementations must be tolerant: errors thrown here are
   * caught + logged by the compactor and do not roll back the
   * summary itself.
   */
  onSummaryCreated(event: SummaryCreatedEvent): Promise<void> | void;
}

export interface SummaryCreatedEvent {
  sessionId: string;
  startSeq: number;
  endSeq: number;
  summaryText: string;
  summaryModel: string;
}

/**
 * DI token. The CompactorService injects by this symbol so the
 * binding can be swapped from the no-op stub to the real
 * implementation by changing one provider registration.
 */
export const FRAGMENTER = Symbol('Fragmenter');
