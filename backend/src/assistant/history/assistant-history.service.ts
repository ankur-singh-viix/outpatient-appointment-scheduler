import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../../auth/auth.types.js';
import { AssistantConversation, AssistantMessage } from '../../database/entities/index.js';

/** A conversation's title is the first message, shortened to about this many characters. */
const TITLE_LENGTH = 60;
/** The longest message text kept (the assistant's replies are the long ones). */
export const MAX_STORED_CHARS = 4000;
/** Conversations kept per person. Saving a new one beyond this deletes the oldest. */
export const MAX_CONVERSATIONS = 200;
/** Messages returned when one conversation is opened (the latest ones, in order). */
const MAX_LOADED_MESSAGES = 200;
const DEFAULT_PAGE = 30;
const MAX_PAGE = 50;

/** What the chat endpoint returns, which is all the history needs from it. */
export interface ChatResult {
  reply: string;
  toolsUsed: string[];
  /** Present when the reply came with a confirmation card. Only the fact is kept. */
  actions?: unknown[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolNames: string[];
  /** The reply had a confirmation card, which has expired: it is never rebuilt from stored data. */
  hadCard: boolean;
  createdAt: string;
}

/**
 * The assistant's chat history. Every query here is filtered by the signed-in user, so another person's conversation is simply "not
 * found" (404, never 403: it does not say that it exists). Only text and lookup names are kept: never a confirmation token and never
 * an action payload, and a reply that came with a card is stored as a plain marker.
 *
 * History is a convenience, never a dependency: callers use `record` and `check`, which turn any database trouble into a warning in
 * the log, so a chat answer is always returned even when history cannot be saved.
 */
@Injectable()
export class AssistantHistoryService {
  private readonly logger = new Logger(AssistantHistoryService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Makes sure `id` is one of this user's conversations before a message is added to it. Throws 404 if it is not. Returns false when the
   * history tables cannot be read at all (nothing will then be saved, and the chat goes on without history).
   */
  async check(user: AuthUser, id: string): Promise<boolean> {
    let found: unknown[];
    try {
      found = await this.dataSource.query('SELECT 1 FROM assistant_conversations WHERE id = $1 AND user_id = $2', [id, user.id]);
    } catch (error) {
      this.logger.warn(`Chat history could not be read (${errorLabel(error)}); the chat continues without it.`);
      return false;
    }
    if (found.length === 0) throw new NotFoundException('Conversation not found.');
    return true;
  }

  /**
   * Saves one exchange (the person's message and the assistant's reply), starting a conversation when there is none. Returns the
   * conversation id, or null if it could not be saved (logged as a warning; never thrown).
   */
  async record(user: AuthUser, conversationId: string | undefined, said: string, result: ChatResult): Promise<string | null> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        let id: string | null = null;
        if (conversationId) {
          const touched = await manager
            .createQueryBuilder()
            .update(AssistantConversation)
            .set({ updatedAt: () => 'now()' })
            .where('id = :id AND user_id = :userId', { id: conversationId, userId: user.id })
            .execute();
          id = touched.affected ? conversationId : null; // deleted in the meantime: a new conversation is started instead of losing the exchange
        }
        if (!id) {
          const created = await manager.save(manager.create(AssistantConversation, { userId: user.id, role: user.role as 'DOCTOR' | 'PATIENT', title: titleOf(said) }));
          id = created.id;
          await manager.query(
            `DELETE FROM assistant_conversations WHERE user_id = $1 AND id NOT IN (SELECT id FROM assistant_conversations WHERE user_id = $1 ORDER BY updated_at DESC, id DESC LIMIT $2)`,
            [user.id, MAX_CONVERSATIONS],
          );
        }
        await manager.insert(AssistantMessage, { conversationId: id, role: 'user', text: clip(said), toolNames: [], hadCard: false });
        await manager.insert(AssistantMessage, { conversationId: id, role: 'assistant', text: clip(result.reply), toolNames: result.toolsUsed.slice(0, 20), hadCard: (result.actions?.length ?? 0) > 0 });
        return id;
      });
    } catch (error) {
      this.logger.warn(`Chat history could not be saved (${errorLabel(error)}); the reply was still returned.`);
      return null;
    }
  }

  /** The user's conversations, newest first, a page at a time. `cursor` is the `nextCursor` of the previous page. */
  async list(user: AuthUser, options: { limit?: number; cursor?: string }): Promise<{ conversations: ConversationSummary[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
    const after = options.cursor ? parseCursor(options.cursor) : null;
    const rows: { id: string; title: string; created_at: Date; updated_at: Date; cursor_ts: string }[] = await this.dataSource.query(
      `SELECT id, title, created_at, updated_at, updated_at::text AS cursor_ts
         FROM assistant_conversations
        WHERE user_id = $1 ${after ? 'AND (updated_at, id) < ($3::timestamptz, $4::uuid)' : ''}
        ORDER BY updated_at DESC, id DESC
        LIMIT $2`,
      after ? [user.id, limit + 1, after.ts, after.id] : [user.id, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      conversations: page.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() })),
      nextCursor: rows.length > limit && last ? Buffer.from(`${last.cursor_ts}|${last.id}`).toString('base64url') : null,
    };
  }

  /** One of the user's conversations with its messages in order (the latest ones if it is very long). */
  async get(user: AuthUser, id: string): Promise<ConversationSummary & { messages: StoredMessage[] }> {
    const [conversation]: { id: string; title: string; created_at: Date; updated_at: Date }[] = await this.dataSource.query(
      'SELECT id, title, created_at, updated_at FROM assistant_conversations WHERE id = $1 AND user_id = $2',
      [id, user.id],
    );
    if (!conversation) throw new NotFoundException('Conversation not found.');
    const messages: { id: string; role: 'user' | 'assistant'; text: string; tool_names: string[]; had_card: boolean; created_at: Date }[] = await this.dataSource.query(
      `SELECT id, role, text, tool_names, had_card, created_at FROM (
         SELECT id, role, text, tool_names, had_card, created_at, seq FROM assistant_messages WHERE conversation_id = $1 ORDER BY seq DESC LIMIT $2
       ) latest ORDER BY seq ASC`,
      [id, MAX_LOADED_MESSAGES],
    );
    return {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.created_at.toISOString(),
      updatedAt: conversation.updated_at.toISOString(),
      messages: messages.map((row) => ({ id: row.id, role: row.role, text: row.text, toolNames: row.tool_names, hadCard: row.had_card, createdAt: row.created_at.toISOString() })),
    };
  }

  /** Deletes one of the user's conversations for good; its messages go with it. */
  async remove(user: AuthUser, id: string): Promise<{ deleted: true }> {
    const gone = await this.dataSource.createQueryBuilder().delete().from(AssistantConversation).where('id = :id AND user_id = :userId', { id, userId: user.id }).execute();
    if (!gone.affected) throw new NotFoundException('Conversation not found.');
    return { deleted: true };
  }
}

/** The first message on one line, cut to about 60 characters. */
export function titleOf(said: string): string {
  const oneLine = said.replace(/\s+/g, ' ').trim();
  return oneLine.length <= TITLE_LENGTH ? oneLine || 'New chat' : `${oneLine.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
}

function clip(text: string): string {
  return text.length <= MAX_STORED_CHARS ? text : `${text.slice(0, MAX_STORED_CHARS - 1)}…`;
}

function parseCursor(cursor: string): { ts: string; id: string } {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  // The timestamp goes into the query as a bound parameter, but is still checked so a made-up cursor is a clear 400 rather than a database error.
  if (!ts || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)?$/.test(ts) || !id || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new BadRequestException('That page cursor is not valid.');
  }
  return { ts, id };
}

/** An error's name and database code only: never its message, which can carry values. */
function errorLabel(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return error instanceof Error ? (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${error.name}, code ${code}` : error.name) : 'error';
}
