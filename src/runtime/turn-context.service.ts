import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BackendId } from '../agent/backends';

export interface TurnContext {
  /** The backend selected for this turn. Drives per-backend routing
   *  decisions inside tools — e.g. PageDeclutterService picks which
   *  cheap model to run the boilerplate-stripping pre-filter on. */
  backend: BackendId;
  /** Per-turn model override, if the client supplied one. Tools that
   *  want to mirror the active model (e.g. running declutter on the
   *  same local Ollama model the agent is using) read this. */
  model?: string;
}

/**
 * Singleton holder for the active turn's backend/model context,
 * propagated through async boundaries (including streamText's tool
 * call dispatch) via Node's AsyncLocalStorage. Set once at the top
 * of AgentLoopService.run; read inside tool execute() callbacks
 * that need to know which model family is driving the turn.
 *
 * Why this exists: tools are registered globally and don't take a
 * per-turn context parameter. We need a way to thread "the active
 * backend is mistral-online" from the agent loop into the
 * fetch_page / browse tool's declutter call so it can route to
 * ministral-14b-latest instead of Anthropic Haiku. AsyncLocalStorage
 * is the standard Node primitive for this — survives every await
 * inside the streamText fullStream consumption without us having
 * to plumb the context through six layers of API.
 */
@Injectable()
export class TurnContextService {
  private readonly als = new AsyncLocalStorage<TurnContext>();

  /**
   * Run `fn` with `ctx` as the active turn context. Any await chain
   * started inside `fn` — including async generators — inherits the
   * context. Outer code that calls `current()` after `fn` returns
   * sees `undefined` again.
   */
  run<T>(ctx: TurnContext, fn: () => T): T {
    return this.als.run(ctx, fn);
  }

  /**
   * Read the active turn context, or undefined if not inside a
   * `run()` scope (e.g. eval scripts that invoke tools directly
   * without going through AgentLoopService).
   */
  current(): TurnContext | undefined {
    return this.als.getStore();
  }
}
