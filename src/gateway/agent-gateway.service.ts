import {
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { JwtVerifierService } from '../auth/jwt-verifier.service';
import { BackendsService } from '../agent/backends';
import {
  SessionService,
  type MessageRecord,
  type SessionRecord,
} from '../sessions/session.service';
import { TurnService } from '../sessions/turn.service';
import type {
  ClientFrame,
  PublicMessage,
  PublicSession,
  ServerFrame,
} from './protocol';

/**
 * WebSocket gateway for the agent runtime. One ws connection = one
 * authenticated user (multiple sessions across the same socket).
 *
 * The first frame after open MUST be `{ type: 'auth', token }`. Until
 * the token is verified, every other frame is rejected. After a
 * successful auth we emit `{ type: 'ready', userId }` and the socket
 * is ready for command frames.
 *
 * All command frames receive a reply (correlated via `inReplyTo` =
 * client-supplied `id`). Turn frames stream as unsolicited server
 * frames correlated by `turnId`.
 */
@Injectable()
export class AgentGatewayService implements OnApplicationShutdown {
  private readonly logger = new Logger(AgentGatewayService.name);
  private wss: WebSocketServer | null = null;

  constructor(
    private readonly auth: JwtVerifierService,
    private readonly sessions: SessionService,
    private readonly turns: TurnService,
    private readonly backends: BackendsService,
  ) {}

  attach(httpServer: HttpServer): void {
    if (this.wss) {
      throw new Error('AgentGatewayService.attach called twice');
    }
    this.wss = new WebSocketServer({ server: httpServer, path: '/v1/agent' });
    this.wss.on('connection', (socket, req) => {
      this.logger.log(
        `ws connected from ${req.socket.remoteAddress ?? 'unknown'}`,
      );
      this.handleConnection(socket).catch((err) => {
        this.logger.error(`connection handler crashed: ${errorMessage(err)}`);
        try {
          socket.close(1011, 'internal error');
        } catch {
          /* ignore */
        }
      });
    });
    this.logger.log('WebSocket gateway mounted at /v1/agent');
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.wss) return;
    await new Promise<void>((resolve) => {
      this.wss!.close(() => resolve());
    });
    this.wss = null;
  }

  private async handleConnection(socket: WebSocket): Promise<void> {
    const conn = new Connection(socket, this);
    await conn.run();
  }

  // The Connection class below uses these accessors instead of
  // private fields to keep the surface explicit.
  get authService(): JwtVerifierService {
    return this.auth;
  }
  get sessionService(): SessionService {
    return this.sessions;
  }
  get turnService(): TurnService {
    return this.turns;
  }
  get backendsService(): BackendsService {
    return this.backends;
  }
}

/**
 * Per-connection state machine. Owns the socket lifecycle and the
 * authenticated user identity once auth completes.
 */
class Connection {
  private readonly logger = new Logger('Connection');
  private userId: string | null = null;
  private clientId: string | null = null;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly gateway: AgentGatewayService,
  ) {}

  async run(): Promise<void> {
    this.socket.on('close', () => {
      this.closed = true;
    });
    this.socket.on('error', (err) => {
      this.logger.warn(`socket error: ${errorMessage(err)}`);
    });

    for await (const frame of iterateFrames(this.socket)) {
      if (this.closed) break;
      try {
        await this.dispatch(frame);
      } catch (err) {
        this.send({
          type: 'error',
          inReplyTo: frame.id,
          code: 'internal',
          message: errorMessage(err),
        });
      }
    }
  }

  private async dispatch(frame: ClientFrame): Promise<void> {
    if (!this.userId) {
      if (frame.type !== 'auth') {
        this.send({
          type: 'error',
          inReplyTo: frame.id,
          code: 'unauthenticated',
          message: 'send { type: "auth", token } first',
        });
        return;
      }
      try {
        const identity = await this.gateway.authService.verify(frame.token);
        this.userId = identity.userId;
        this.clientId = identity.clientId;
        this.logger.log(
          `auth ok userId=${identity.userId} clientId=${identity.clientId}`,
        );
        this.send({
          type: 'ready',
          inReplyTo: frame.id,
          userId: identity.userId,
        });
      } catch (err) {
        this.logger.warn(`auth failed: ${errorMessage(err)}`);
        this.send({
          type: 'error',
          inReplyTo: frame.id,
          code: 'auth_failed',
          message: errorMessage(err),
        });
        this.socket.close(4001, 'auth failed');
      }
      return;
    }

    const userId = this.userId;
    const clientId = this.clientId;
    if (!clientId) {
      // Belt-and-braces: userId was set on auth, clientId is set in
      // the same branch, so this can't happen unless the auth path
      // regresses. Fail loudly rather than silently scope to nothing.
      this.send({
        type: 'error',
        inReplyTo: frame.id,
        code: 'unauthenticated',
        message: 'connection missing client_id after auth',
      });
      return;
    }

    switch (frame.type) {
      case 'auth':
        this.send({
          type: 'error',
          inReplyTo: frame.id,
          code: 'already_authenticated',
          message: 'connection is already authenticated',
        });
        return;

      case 'session.create': {
        const session = await this.gateway.sessionService.createSession({
          clientId,
          userId,
          title: frame.title,
          systemPrompt: frame.systemPrompt,
          defaultBackend: frame.defaultBackend,
        });
        this.send({
          type: 'session.created',
          inReplyTo: frame.id,
          session: toPublicSession(session),
        });
        return;
      }

      case 'session.list': {
        const sessions = await this.gateway.sessionService.listSessions(
          clientId,
          userId,
          frame.limit,
        );
        this.send({
          type: 'session.list',
          inReplyTo: frame.id,
          sessions: sessions.map(toPublicSession),
        });
        return;
      }

      case 'session.get': {
        const session = await this.gateway.sessionService.getSession(
          frame.sessionId,
          clientId,
          userId,
        );
        const messages = await this.gateway.sessionService.getMessages(
          frame.sessionId,
          clientId,
          userId,
        );
        this.send({
          type: 'session.detail',
          inReplyTo: frame.id,
          session: toPublicSession(session),
          messages: messages.map(toPublicMessage),
        });
        return;
      }

      case 'session.archive': {
        await this.gateway.sessionService.archiveSession(
          frame.sessionId,
          clientId,
          userId,
        );
        this.send({
          type: 'session.archived',
          inReplyTo: frame.id,
          sessionId: frame.sessionId,
        });
        return;
      }

      case 'backends.list':
        this.send({
          type: 'backends.list',
          inReplyTo: frame.id,
          defaultBackend: this.gateway.backendsService.defaultBackend(),
          backends: this.gateway.backendsService.available(),
        });
        return;

      case 'session.set_backend': {
        const session = await this.gateway.sessionService.setSessionBackend(
          frame.sessionId,
          clientId,
          userId,
          frame.backend,
        );
        this.send({
          type: 'session.backend_set',
          inReplyTo: frame.id,
          session: toPublicSession(session),
        });
        return;
      }

      case 'turn.submit': {
        await this.runTurnStream(clientId, userId, frame);
        return;
      }
    }
  }

  private async runTurnStream(
    clientId: string,
    userId: string,
    frame: import('./protocol').ClientTurnSubmitFrame,
  ): Promise<void> {
    const events = this.gateway.turnService.runTurn({
      sessionId: frame.sessionId,
      clientId,
      userId,
      userMessage: frame.message,
      backendOverride: frame.backend,
      turnId: frame.turnId,
      maxSteps: frame.maxSteps,
      maxOutputTokens: frame.maxOutputTokens,
    });
    for await (const evt of events) {
      if (this.closed) break;
      this.send(translateAgentEvent(evt, frame.id));
    }
  }

  private send(frame: ServerFrame): void {
    if (this.closed) return;
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }
}

async function* iterateFrames(socket: WebSocket): AsyncGenerator<ClientFrame> {
  // Buffer queue + close/error signalling, since `ws` is event-based.
  type Pending =
    | { kind: 'frame'; frame: ClientFrame }
    | { kind: 'invalid'; raw: string; error: string }
    | { kind: 'close' };

  const queue: Pending[] = [];
  let waiter: (() => void) | null = null;
  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  socket.on('message', (data) => {
    let text: string;
    if (typeof data === 'string') {
      text = data;
    } else if (Buffer.isBuffer(data)) {
      text = data.toString('utf8');
    } else {
      text = '';
    }
    try {
      const parsed = JSON.parse(text) as ClientFrame;
      queue.push({ kind: 'frame', frame: parsed });
    } catch (err) {
      queue.push({ kind: 'invalid', raw: text, error: errorMessage(err) });
    }
    wake();
  });
  socket.on('close', () => {
    queue.push({ kind: 'close' });
    wake();
  });

  while (true) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
    const item = queue.shift();
    if (!item) continue;
    if (item.kind === 'close') return;
    if (item.kind === 'invalid') {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'error',
            code: 'bad_json',
            message: item.error,
          } satisfies ServerFrame),
        );
      }
      continue;
    }
    yield item.frame;
  }
}

function translateAgentEvent(
  evt: import('../agent/agent.types').AgentEvent,
  requestId: string | undefined,
): ServerFrame {
  switch (evt.kind) {
    case 'turn-accepted':
      return {
        type: 'turn.accepted',
        inReplyTo: requestId,
        turnId: evt.turnId,
        backend: evt.backend,
        model: evt.model,
      };
    case 'text-delta':
      return {
        type: 'turn.text_delta',
        inReplyTo: requestId,
        turnId: evt.turnId,
        delta: evt.delta,
      };
    case 'reasoning-delta':
      return {
        type: 'turn.thinking_delta',
        inReplyTo: requestId,
        turnId: evt.turnId,
        delta: evt.delta,
      };
    case 'tool-call-started':
      return {
        type: 'turn.tool_use_started',
        inReplyTo: requestId,
        turnId: evt.turnId,
        toolCallId: evt.toolCallId,
        toolName: evt.toolName,
        input: evt.input,
      };
    case 'tool-call-completed':
      return {
        type: 'turn.tool_use_completed',
        inReplyTo: requestId,
        turnId: evt.turnId,
        toolCallId: evt.toolCallId,
        toolName: evt.toolName,
        output: evt.output,
      };
    case 'tool-call-failed':
      return {
        type: 'turn.tool_use_failed',
        inReplyTo: requestId,
        turnId: evt.turnId,
        toolCallId: evt.toolCallId,
        toolName: evt.toolName,
        error: evt.error,
      };
    case 'turn-done':
      return {
        type: 'turn.done',
        inReplyTo: requestId,
        turnId: evt.turnId,
        usage: evt.usage,
        finishReason: evt.finishReason,
      };
    case 'turn-error':
      return {
        type: 'turn.error',
        inReplyTo: requestId,
        turnId: evt.turnId,
        error: evt.error,
      };
  }
}

function toPublicSession(s: SessionRecord): PublicSession {
  return {
    id: s.id,
    title: s.title,
    systemPrompt: s.systemPrompt,
    defaultBackend: s.defaultBackend,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    totalTokenCount: s.totalTokenCount,
  };
}

function toPublicMessage(m: MessageRecord): PublicMessage {
  return {
    id: m.id,
    turnId: m.turnId,
    role: m.role,
    content: m.content,
    text: m.text,
    seq: m.seq,
    createdAt: m.createdAt.toISOString(),
    metadata: m.metadata,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
