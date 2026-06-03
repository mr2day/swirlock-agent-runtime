import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ActiveSessionsService } from './active-sessions.service';
import { CompactorService } from './compactor.service';

/**
 * Periodic background scanner that walks every active session and
 * runs `CompactorService.compactIfNeeded` for those that are idle
 * (no turn currently in flight per ActiveSessionsService).
 *
 * Cadence: COMPACTION_SCAN_INTERVAL_MS, default 5 minutes. Set
 * to 0 to disable the scheduler entirely (the compactor itself
 * remains DI-available so a smoke script can drive it manually).
 *
 * The scheduler is intentionally simple: scan, iterate, ignore
 * failures. Compaction is a best-effort background activity; if
 * one session fails we move to the next.
 */
@Injectable()
export class CompactionSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(CompactionSchedulerService.name);

  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly active: ActiveSessionsService,
    private readonly compactor: CompactorService,
  ) {}

  onModuleInit(): void {
    const intervalMs = Number(
      process.env.COMPACTION_SCAN_INTERVAL_MS ?? '300000',
    );
    if (intervalMs <= 0) {
      this.logger.log('compaction scheduler disabled (interval=0)');
      return;
    }
    this.logger.log(`compaction scheduler armed, every ${intervalMs}ms`);
    // First scan after one full interval — gives the runtime a
    // grace period at startup before doing background work.
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Public for smoke scripts: a single scan pass, awaitable.
   */
  async scanOnce(): Promise<void> {
    let sessionIds: string[];
    try {
      const rows = await this.database.db
        .selectFrom('sessions')
        .select('id')
        .where('status', '=', 'active')
        .execute();
      sessionIds = rows.map((r) => r.id);
    } catch (err) {
      this.logger.warn(
        `compaction scan: enumerating sessions failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    let compacted = 0;
    let skipped = 0;
    for (const sessionId of sessionIds) {
      if (this.active.isActive(sessionId)) {
        skipped++;
        continue;
      }
      try {
        // The compactor short-circuits when not needed, so this is
        // cheap on under-budget sessions.
        await this.compactor.compactIfNeeded(sessionId);
        compacted++;
      } catch (err) {
        this.logger.warn(
          `compaction scan: session=${sessionId} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (sessionIds.length > 0) {
      this.logger.debug(
        `compaction scan: ${sessionIds.length} total, ${skipped} active-skipped, ${compacted} processed`,
      );
    }
  }
}
