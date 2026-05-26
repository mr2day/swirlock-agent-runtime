import type { Backend } from '../database/schema';
import type { BackendChoice, BackendInfo } from '../agent/agent.types';

// =====================================================================
// CLIENT -> SERVER envelopes
// =====================================================================

export interface ClientFrameBase {
  id?: string; // optional client-supplied correlation id
}

export interface ClientAuthFrame extends ClientFrameBase {
  type: 'auth';
  token: string; // raw JWT, no Bearer prefix
}

export interface ClientSessionCreateFrame extends ClientFrameBase {
  type: 'session.create';
  title?: string;
  systemPrompt?: string;
  defaultBackend?: Backend;
}

export interface ClientSessionListFrame extends ClientFrameBase {
  type: 'session.list';
  limit?: number;
}

export interface ClientSessionGetFrame extends ClientFrameBase {
  type: 'session.get';
  sessionId: string;
}

export interface ClientSessionArchiveFrame extends ClientFrameBase {
  type: 'session.archive';
  sessionId: string;
}

export interface ClientBackendsListFrame extends ClientFrameBase {
  type: 'backends.list';
}

export interface ClientSessionSetBackendFrame extends ClientFrameBase {
  type: 'session.set_backend';
  sessionId: string;
  backend: Backend;
}

export interface ClientTurnSubmitFrame extends ClientFrameBase {
  type: 'turn.submit';
  sessionId: string;
  message: string;
  turnId?: string;
  backend?: BackendChoice;
  maxSteps?: number;
  maxOutputTokens?: number;
}

export type ClientFrame =
  | ClientAuthFrame
  | ClientSessionCreateFrame
  | ClientSessionListFrame
  | ClientSessionGetFrame
  | ClientSessionArchiveFrame
  | ClientSessionSetBackendFrame
  | ClientBackendsListFrame
  | ClientTurnSubmitFrame;

// =====================================================================
// SERVER -> CLIENT envelopes
// =====================================================================

export interface ServerFrameBase {
  // Echoed from the request frame's `id` when applicable, otherwise
  // omitted (for unsolicited server frames such as in-flight turn
  // events, where correlation happens by turnId).
  inReplyTo?: string;
}

export type ServerFrame =
  | (ServerFrameBase & { type: 'ready'; userId: string })
  | (ServerFrameBase & { type: 'error'; code: string; message: string })
  | (ServerFrameBase & {
      type: 'session.created';
      session: PublicSession;
    })
  | (ServerFrameBase & {
      type: 'session.list';
      sessions: PublicSession[];
    })
  | (ServerFrameBase & {
      type: 'session.detail';
      session: PublicSession;
      messages: PublicMessage[];
    })
  | (ServerFrameBase & {
      type: 'session.archived';
      sessionId: string;
    })
  | (ServerFrameBase & {
      type: 'backends.list';
      defaultBackend: Backend;
      backends: BackendInfo[];
    })
  | (ServerFrameBase & {
      type: 'session.backend_set';
      session: PublicSession;
    })
  | (ServerFrameBase & {
      type: 'turn.accepted';
      turnId: string;
      backend: Backend;
      model: string;
    })
  | (ServerFrameBase & {
      type: 'turn.text_delta';
      turnId: string;
      delta: string;
    })
  | (ServerFrameBase & {
      type: 'turn.thinking_delta';
      turnId: string;
      delta: string;
    })
  | (ServerFrameBase & {
      type: 'turn.tool_use_started';
      turnId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    })
  | (ServerFrameBase & {
      type: 'turn.tool_use_completed';
      turnId: string;
      toolCallId: string;
      toolName: string;
      output: unknown;
    })
  | (ServerFrameBase & {
      type: 'turn.tool_use_failed';
      turnId: string;
      toolCallId: string;
      toolName: string;
      error: string;
    })
  | (ServerFrameBase & {
      type: 'turn.done';
      turnId: string;
      usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      finishReason: string;
    })
  | (ServerFrameBase & {
      type: 'turn.error';
      turnId: string;
      error: string;
    });

export interface PublicSession {
  id: string;
  title: string | null;
  systemPrompt: string | null;
  defaultBackend: Backend | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  totalTokenCount: number;
}

export interface PublicMessage {
  id: string;
  turnId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: unknown;
  text: string;
  seq: number;
  createdAt: string;
  // Free-form per-message metadata. Today the agent stamps assistant
  // messages with `{ backend, modelId }` so the UI can show per-turn
  // model attribution. Null for user messages and pre-attribution
  // assistant messages.
  metadata: Record<string, unknown> | null;
}
