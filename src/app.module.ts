import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { GatewayModule } from './gateway/gateway.module';
import { SessionsModule } from './sessions/sessions.module';
import { ToolsModule } from './tools/tools.module';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    ToolsModule,
    AgentModule,
    SessionsModule,
    GatewayModule,
  ],
})
export class AppModule {}
