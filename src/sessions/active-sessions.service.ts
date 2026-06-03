import { Injectable } from '@nestjs/common';

/**
 * In-memory set of session IDs that have a turn currently
 * in-flight. Updated by the gateway when it starts / ends a
 * `runTurnStream`; queried by the compaction scheduler so a
 * compactor never races a live turn on the same session.
 *
 * In-memory is fine because: (1) a compactor running on session X
 * concurrently with a turn on session X is the worst case and that
 * cannot happen WITHIN one runtime process, (2) we currently run
 * one runtime process; horizontal scale isn't a requirement, (3)
 * if the process restarts mid-turn, the gateway connection drops
 * too and the next compactor scan correctly sees the session as
 * idle.
 */
@Injectable()
export class ActiveSessionsService {
  private readonly active = new Set<string>();

  markActive(sessionId: string): void {
    this.active.add(sessionId);
  }

  markIdle(sessionId: string): void {
    this.active.delete(sessionId);
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }
}
