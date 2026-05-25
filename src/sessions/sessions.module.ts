import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { SessionService } from './session.service';
import { TurnService } from './turn.service';

@Module({
  imports: [AgentModule],
  providers: [SessionService, TurnService],
  exports: [SessionService, TurnService],
})
export class SessionsModule {}
