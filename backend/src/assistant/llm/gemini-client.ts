import { Injectable, Logger } from '@nestjs/common';
import { loadConfig } from '../../config.js';
import { LlmError, type LlmClient, type LlmMessage, type LlmRequest, type LlmResponse, type ToolCall } from './llm-client.js';

/** The slice of Gemini's generateContent reply we read. Everything is optional because we never trust the shape. */
interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
  [other: string]: unknown;
}
interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}
interface GeminiReply {
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

/**
 * Google Gemini over plain HTTPS (generateContent with function calling), no SDK. The key goes in a header, never in the URL, and is
 * never logged. A model turn is kept exactly as Gemini sent it (`provider`) and sent back unchanged on the next round, because newer
 * Gemini models attach signatures to their function calls that must come back with them.
 */
@Injectable()
export class GeminiClient implements LlmClient {
  private readonly logger = new Logger(GeminiClient.name);
  private readonly settings = loadConfig().assistant;

  get configured(): boolean {
    return this.settings.geminiApiKey.length > 0;
  }

  async generate(request: LlmRequest): Promise<LlmResponse> {
    if (!this.configured) throw new LlmError('not_configured', 'GEMINI_API_KEY is not set.');
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: request.messages.map(toContent),
      generationConfig: { maxOutputTokens: request.maxOutputTokens, temperature: 0.2 },
      ...(request.tools.length > 0
        ? { tools: [{ functionDeclarations: request.tools }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }
        : {}),
    };
    const reply = await this.post(body, Math.max(1, Math.min(request.timeoutMs ?? this.settings.timeoutMs, this.settings.timeoutMs)));
    return parse(reply);
  }

  /** One request, with a single retry for a server-side hiccup or a connection that failed at once (never for a timeout). Failures become LlmError; the provider's own text is not passed on. */
  private async post(body: unknown, timeoutMs: number): Promise<GeminiReply> {
    const url = `${this.settings.geminiBaseUrl}/v1beta/models/${encodeURIComponent(this.settings.geminiModel)}:generateContent`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.settings.geminiApiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        this.logger.warn(`Gemini request failed (${(error as Error).name}).`);
        // A timeout means the whole allowance is spent: asking again would only double the wait. A connection that failed at once is retried once.
        if (attempt === 2 || (error as Error).name === 'TimeoutError') throw new LlmError('unavailable', 'The model could not be reached.');
        continue;
      }
      if (response.ok) {
        try {
          return (await response.json()) as GeminiReply;
        } catch {
          throw new LlmError('bad_response', 'The model sent an unreadable reply.');
        }
      }
      this.logger.warn(`Gemini answered HTTP ${response.status}.`);
      if (response.status === 429) throw new LlmError('rate_limited', 'The model is busy.');
      if (response.status >= 500 && attempt === 1) continue;
      if (response.status === 401 || response.status === 403) throw new LlmError('not_configured', 'The model key was refused.');
      throw new LlmError(response.status >= 500 ? 'unavailable' : 'bad_response', `The model answered HTTP ${response.status}.`);
    }
    throw new LlmError('unavailable', 'The model could not be reached.');
  }
}

function toContent(message: LlmMessage): GeminiContent {
  if (message.role === 'user') return { role: 'user', parts: [{ text: message.text }] };
  if (message.role === 'tool') {
    return {
      role: 'user',
      parts: message.results.map((result) => ({
        functionResponse: { ...(result.providerId ? { id: result.providerId } : {}), name: result.name, response: { result: result.output } },
      })),
    };
  }
  if (message.provider) return message.provider as GeminiContent;
  return {
    role: 'model',
    parts: [
      ...(message.text ? [{ text: message.text }] : []),
      ...message.toolCalls.map((call) => ({ functionCall: { ...(call.providerId ? { id: call.providerId } : {}), name: call.name, args: call.args } })),
    ],
  };
}

function parse(reply: GeminiReply): LlmResponse {
  const candidate = reply.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts
    .filter((part) => typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text as string)
    .join('')
    .trim();
  const toolCalls: ToolCall[] = [];
  for (const part of parts) {
    const call = part.functionCall;
    if (!call?.name) continue;
    toolCalls.push({ id: `call-${toolCalls.length + 1}`, name: call.name, args: call.args ?? {}, providerId: call.id });
  }
  if (!text && toolCalls.length === 0) {
    if (reply.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY') throw new LlmError('blocked', 'The model declined to answer.');
    throw new LlmError('bad_response', 'The model sent an empty reply.');
  }
  return { text, toolCalls, provider: candidate?.content };
}
