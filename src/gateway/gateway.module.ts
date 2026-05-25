import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { SessionsModule } from '../sessions/sessions.module';
import { AgentGatewayService } from './agent-gateway.service';

@Module({
  imports: [AgentModule, SessionsModule],
  providers: [AgentGatewayService],
  exports: [AgentGatewayService],
})
export class GatewayModule {}
