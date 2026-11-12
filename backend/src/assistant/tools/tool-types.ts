import { z } from 'zod';
import type { AuthUser } from '../../auth/auth.types.js';
import { isValidDate } from '../../scheduling/calendar.js';
import { dateSchema, timeSchema } from '../../scheduling/schemas.js';
import type { ActionCard } from '../actions/action-cards.js';

/**
 * Who is asking and when, from the verified server-side session. Tools take their identity from here and only from here: no tool has a
 * parameter that names "the doctor" or "the patient" to act as.
 */
export interface ToolContext {
  user: AuthUser;
  /** Today in the clinic's time zone, YYYY-MM-DD. */
  today: string;
  /** Now in the clinic's time zone, HH:MM. */
  time: string;
  /**
   * Confirmation cards prepared during this one answer. A preparation tool adds its card here; the card goes to the patient's screen with
   * the reply and never passes through the model, so the model cannot forge, see or press one.
   */
  cards: ActionCard[];
  /** True while a preparation is under way, so two parallel calls in one answer cannot both prepare a card. */
  preparing: boolean;
}

/** The model sent arguments that do not fit the tool. The message goes back to the model so it can correct itself. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/** One read-only capability the model may use. */
export interface AssistantTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as the model sees it. */
  parameters: Record<string, unknown>;
  /** Validates the model's arguments, then runs. Throws ToolInputError for bad arguments; other errors come from the real services. */
  execute(context: ToolContext, args: unknown): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(definition: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  input: S;
  run: (context: ToolContext, input: z.infer<S>) => Promise<unknown>;
}): AssistantTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    async execute(context, args) {
      const parsed = definition.input.safeParse(args ?? {});
      if (!parsed.success) throw new ToolInputError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
      return definition.run(context, parsed.data);
    },
  };
}

/** A time of day, HH:MM. */
export const clockTime = timeSchema;

/** A real calendar date, YYYY-MM-DD. */
export const calendarDate = dateSchema.refine(isValidDate, { message: 'is not a real calendar date' });

export const objectSchema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });

export const DATE_PROPERTY = { type: 'string', description: 'A date as YYYY-MM-DD in the clinic time zone.' };
