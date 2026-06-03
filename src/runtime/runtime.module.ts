import { Global, Module } from '@nestjs/common';
import { TurnContextService } from './turn-context.service';

/**
 * @Global so any module — agent, tools, gateway — can inject
 * `TurnContextService` without an explicit import chain. The single
 * AsyncLocalStorage instance is the source of truth for "which
 * backend is driving the current turn", read by tools that route
 * their internal model calls by backend family.
 */
@Global()
@Module({
  providers: [TurnContextService],
  exports: [TurnContextService],
})
export class RuntimeModule {}
