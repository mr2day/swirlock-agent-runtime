import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { ActiveSessionsService } from './active-sessions.service';
import { CompactionSchedulerService } from './compaction-scheduler.service';
import { CompactorService } from './compactor.service';
import { ContextWindowService } from './context-window.service';
import { FRAGMENTER } from './fragmenter.interface';
import { NoopFragmenter } from './fragmenter.noop';
import { SessionService } from './session.service';
import { TurnService } from './turn.service';

@Module({
  imports: [AgentModule],
  providers: [
    SessionService,
    TurnService,
    ContextWindowService,
    ActiveSessionsService,
    CompactorService,
    CompactionSchedulerService,
    NoopFragmenter,
    // Bind the FRAGMENTER token to the no-op for now. Replacing the
    // `useExisting` target is the only line that needs to change
    // when the real Fragmenter ships.
    { provide: FRAGMENTER, useExisting: NoopFragmenter },
  ],
  exports: [
    SessionService,
    TurnService,
    ActiveSessionsService,
    CompactorService,
  ],
})
export class SessionsModule {}
