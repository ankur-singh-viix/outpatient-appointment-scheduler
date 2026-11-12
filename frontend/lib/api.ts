import { API_URL } from './config';
import { saveSession } from './session';
import type { TokenGetter } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** One entry per validation problem, like "password: must be at least 8 characters". */
    readonly details: string[] = [],
    /** A machine-readable reason some endpoints add, for example EMAIL_NOT_VERIFIED. */
    readonly code?: string,
    /** On 429 responses: how long to wait before trying again. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** A stored token (legacy login) or a function that fetches a fresh one (Clerk). */
  token?: string | TokenGetter | null;
}

/** Calls the backend API and returns parsed JSON, throwing ApiError with a readable message. */
export async function api<T>(path: string, { method = 'GET', body, token }: RequestOptions = {}): Promise<T> {
  // Clerk tokens are fetched fresh for each request, because they expire within about a minute.
  let bearer: string | null | undefined;
  try {
    bearer = typeof token === 'function' ? await token() : token;
  } catch {
    bearer = null;
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // An expired or invalid stored token: sign out so the UI asks the user to sign in again. (Clerk looks after its own session.)
    if (response.status === 401 && typeof token === 'string') saveSession(null);
    const body = data as { message?: string | string[]; code?: string; retryAfterSeconds?: number } | null;
    const message = body?.message;
    throw new ApiError(
      response.status,
      Array.isArray(message) ? message.join('. ') : (message ?? `Request failed (${response.status}).`),
      Array.isArray(message) ? message : message ? [message] : [],
      body?.code,
      body?.retryAfterSeconds,
    );
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
