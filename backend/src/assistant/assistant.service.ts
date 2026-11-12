import { BadGatewayException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppointmentsService } from '../appointments/appointments.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { loadConfig } from '../config.js';
import { AvailabilityChangeService } from '../doctor-portal/availability-change.service.js';
import { DoctorPortalService } from '../doctor-portal/doctor-portal.service.js';
import { DoctorsService } from '../doctors/doctors.service.js';
import type { ActionCard } from './actions/action-cards.js';
import { AssistantActionsService } from './actions/assistant-actions.service.js';
import { ScheduleChangeActionsService } from './actions/schedule-change-actions.service.js';
import { clinicNow } from '../scheduling/calendar.js';
import { LLM_CLIENT, LlmError, type LlmClient, type LlmMessage, type ToolCall, type ToolResult } from './llm/llm-client.js';
import { DECLINED_REPLY, EMPTY_REPLY, systemPrompt, type AssistantRole, type PromptOptions } from './prompts.js';
import { RateLimiter } from './rate-limit.js';
import { doctorTools } from './tools/doctor-tools.js';
import { patientTools } from './tools/patient-tools.js';
import { ToolInputError, type AssistantTool, type ToolContext } from './tools/tool-types.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** The most turns of conversation sent to the model, so a long chat cannot grow the cost of every message. */
export const MAX_HISTORY = 10;
/** How many times the model may ask for tools before it must answer. */
export const MAX_TOOL_ROUNDS = 4;
/** How many tools it may run at once in one round. */
const MAX_CALLS_PER_ROUND = 4;
/** A tool answer larger than this is not sent to the model (it would only cost money); the model is told to narrow the question. */
const MAX_RESULT_CHARS = 12_000;

/**
 * The one place the assistant is run. It is provider-neutral (it talks to an LlmClient) and role-aware (it hands the model only the
 * tools for the signed-in user's role). It keeps no conversation on the server: the browser sends the recent turns each time.
 * Every tool is read-only and identity comes from the verified user passed in here, so nothing the model or the person types can
 * make it act as someone else.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  private readonly config = loadConfig();
  private readonly limiter = new RateLimiter(this.config.assistant.rateLimit, this.config.assistant.rateWindowMinutes * 60_000);
  private readonly toolsByRole: Partial<Record<AssistantRole, AssistantTool[]>>;

  constructor(
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    portal: DoctorPortalService,
    changes: AvailabilityChangeService,
    doctors: DoctorsService,
    appointments: AppointmentsService,
    dataSource: DataSource,
    actions: AssistantActionsService,
    scheduleChanges: ScheduleChangeActionsService,
  ) {
    this.toolsByRole = {
      DOCTOR: doctorTools({ portal, changes, doctors, dataSource, scheduleChanges }),
      PATIENT: patientTools({ appointments, doctors, actions }),
    };
  }

  /** `actions` is present only when the answer comes with a confirmation card for the patient to press (never written by the model). */
  async chat(user: AuthUser, messages: ChatMessage[], options: PromptOptions = {}): Promise<{ reply: string; toolsUsed: string[]; actions?: ActionCard[] }> {
    const tools = this.toolsByRole[user.role as AssistantRole];
    if (!tools) throw new ForbiddenException('The assistant is available to doctors and patients.');
    if (!this.llm.configured) throw new ServiceUnavailableException('The assistant is not set up yet. Please ask the clinic administrator to enable it.');
    const turn = this.limiter.take(user.id);
    if (!turn.allowed) {
      throw new HttpException(`You have sent a lot of messages. Please wait about ${Math.ceil(turn.retryAfterSeconds / 60)} minute(s) and try again.`, HttpStatus.TOO_MANY_REQUESTS);
    }

    const clock = clinicNow(this.config.clinicTimezone);
    const context: ToolContext = { user, today: clock.date, time: clock.time, cards: [], preparing: false };
    const outcome = (reply: string) => ({ reply, toolsUsed: [...new Set(toolsUsed)], ...(context.cards.length > 0 ? { actions: context.cards } : {}) });
    const system = systemPrompt(user.role as AssistantRole, { name: user.name, today: clock.date, time: clock.time, timeZone: this.config.clinicTimezone }, options);
    const conversation = this.history(messages);
    const toolsUsed: string[] = [];
    const startedAt = Date.now();
    const budgetMs = this.config.assistant.timeoutMs * 2;

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        // One chat gets a fixed total time, however many rounds it takes, so a slow model cannot keep a person waiting for minutes.
        const left = budgetMs - (Date.now() - startedAt);
        if (left <= 0) {
          this.logger.warn(`assistant gave up after ${Math.round(budgetMs / 1000)}s (${toolsUsed.length} lookups done).`);
          throw new LlmError('unavailable', 'The assistant took too long.');
        }
        // After the last round the model gets no tools, so it has to answer with what it has.
        const offered = round < MAX_TOOL_ROUNDS ? tools : [];
        const response = await this.llm.generate({
          timeoutMs: left,
          system,
          messages: conversation,
          tools: offered.map(({ name, description, parameters }) => ({ name, description, parameters })),
          maxOutputTokens: this.config.assistant.maxOutputTokens,
        });
        if (response.toolCalls.length === 0 || offered.length === 0) {
          this.logger.log(`assistant ${user.role} rounds=${round} tools=[${toolsUsed.join(',')}] ${Date.now() - startedAt}ms`);
          return outcome(response.text || EMPTY_REPLY);
        }
        conversation.push({ role: 'assistant', text: response.text, toolCalls: response.toolCalls, provider: response.provider });
        const results = await Promise.all(response.toolCalls.map((call, index) => this.runTool(tools, context, call, index)));
        for (const call of response.toolCalls) toolsUsed.push(call.name);
        conversation.push({ role: 'tool', results });
      }
    } catch (error) {
      // The model declining to answer is an ordinary reply, not a failure.
      if (error instanceof LlmError && error.kind === 'blocked') return outcome(DECLINED_REPLY);
      throw this.friendly(error);
    }
    return outcome(EMPTY_REPLY);
  }

  /** The last MAX_HISTORY turns, starting with one from the person (a model turn cannot open a conversation). */
  private history(messages: ChatMessage[]): LlmMessage[] {
    const recent = messages.slice(-MAX_HISTORY);
    const first = recent.findIndex((message) => message.role === 'user');
    return recent.slice(Math.max(first, 0)).map((message): LlmMessage => (message.role === 'user' ? { role: 'user', text: message.content } : { role: 'assistant', text: message.content, toolCalls: [] }));
  }

  /** Runs one tool. Whatever goes wrong becomes a short result the model can explain; nothing internal is passed on. */
  private async runTool(tools: AssistantTool[], context: ToolContext, call: ToolCall, index: number): Promise<ToolResult> {
    const base = { callId: call.id, name: call.name, providerId: call.providerId };
    const tool = tools.find((candidate) => candidate.name === call.name);
    if (!tool) return { ...base, output: { error: 'That tool does not exist.' } };
    if (index >= MAX_CALLS_PER_ROUND) return { ...base, output: { error: 'Too many lookups at once. Ask for fewer things at a time.' } };
    try {
      const output = await tool.execute(context, call.args);
      if (JSON.stringify(output ?? null).length > MAX_RESULT_CHARS) return { ...base, output: { error: 'That result was too large. Ask about a narrower date range or fewer items.' } };
      return { ...base, output: output ?? null };
    } catch (error) {
      if (error instanceof ToolInputError) return { ...base, output: { error: `Invalid input: ${error.message}` } };
      if (error instanceof HttpException && error.getStatus() < 500 && error.getStatus() !== HttpStatus.FORBIDDEN) return { ...base, output: { error: error.message } };
      this.logger.warn(`tool ${call.name} failed (${errorLabel(error)}).`);
      return { ...base, output: { error: 'That information is temporarily unavailable.' } };
    }
  }

  /** Turns a model failure into a calm, specific message for the person. */
  private friendly(error: unknown): Error {
    if (error instanceof LlmError) {
      if (error.kind === 'not_configured') return new ServiceUnavailableException('The assistant is not set up yet. Please ask the clinic administrator to enable it.');
      if (error.kind === 'rate_limited') return new HttpException('The assistant is busy right now. Please try again in a moment.', HttpStatus.TOO_MANY_REQUESTS);
      return new BadGatewayException('The assistant is temporarily unavailable. Please try again in a moment.');
    }
    this.logger.error(`assistant failed (${error instanceof Error ? error.name : 'error'}).`);
    return new BadGatewayException('The assistant ran into a problem. Please try again.');
  }
}


/** An error described without its message (which can hold data): its class, and the database's own error code when it has one (such as 42P01, a missing table). */
function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return 'error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${error.name}, code ${code}` : error.name;
}
