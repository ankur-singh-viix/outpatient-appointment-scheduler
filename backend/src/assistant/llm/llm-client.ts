/**
 * What the assistant needs from a language model, in neutral terms. The orchestrator (AssistantService) speaks only this, so changing
 * provider means writing one more class that implements LlmClient (Gemini is the first: gemini-client.ts) and binding it to LLM_CLIENT.
 */

/** A function the model may ask us to run. `parameters` is a JSON Schema object. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The model asking for one tool to run. */
export interface ToolCall {
  /** Our own id for this call within one answer. */
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** The provider's own id for the call, when it sends one, so the result can be matched to it. */
  providerId?: string;
}

/** What a tool returned (or why it failed), handed back to the model. */
export interface ToolResult {
  callId: string;
  name: string;
  output: unknown;
  providerId?: string;
}

export type LlmMessage =
  | { role: 'user'; text: string }
  /** `provider` is the provider's own copy of this turn, kept untouched and replayed as it was (some providers require that). */
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; provider?: unknown }
  | { role: 'tool'; results: ToolResult[] };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: ToolDeclaration[];
  maxOutputTokens: number;
  /** How long this one call may take (the caller shortens it as its overall time budget runs out). Defaults to the configured timeout. */
  timeoutMs?: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  provider?: unknown;
}

/** Why a model call failed, in terms the orchestrator can turn into a calm message. Never carries a key or the provider's raw reply. */
export type LlmErrorKind = 'not_configured' | 'rate_limited' | 'unavailable' | 'blocked' | 'bad_response';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmClient {
  /** False when the provider has no credentials: the assistant then says so instead of guessing. */
  readonly configured: boolean;
  generate(request: LlmRequest): Promise<LlmResponse>;
}

/** Injection token for the provider in use. */
export const LLM_CLIENT = Symbol('LLM_CLIENT');
