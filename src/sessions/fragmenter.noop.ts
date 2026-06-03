import { Injectable, Logger } from '@nestjs/common';
import type { Fragmenter, SummaryCreatedEvent } from './fragmenter.interface';

/**
 * No-op Fragmenter implementation. Registered as the default
 * binding for FRAGMENTER so the compactor's hook always fires;
 * the real Fragmenter will replace this binding when it ships
 * without changes anywhere else.
 *
 * Logs each event at debug level so we can confirm during testing
 * that the compactor is actually calling through.
 */
@Injectable()
export class NoopFragmenter implements Fragmenter {
  private readonly logger = new Logger(NoopFragmenter.name);

  onSummaryCreated(event: SummaryCreatedEvent): void {
    this.logger.debug(
      `fragmenter stub: session=${event.sessionId} seqs=${event.startSeq}-${event.endSeq} model=${event.summaryModel}`,
    );
  }
}
