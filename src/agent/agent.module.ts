import { Module } from '@nestjs/common';
import { AgentLoopService } from './agent-loop.service';
import { BackendsService } from './backends';

@Module({
  providers: [BackendsService, AgentLoopService],
  exports: [BackendsService, AgentLoopService],
})
export class AgentModule {}
