import { API_URL } from './config';
import { saveSession } from './session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string | null;
}

/** Calls the backend API and returns parsed JSON, throwing ApiError with a readable message. */
export async function api<T>(path: string, { method = 'GET', body, token }: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }

  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // An expired or invalid token: sign out so the UI asks the user to sign in again.
    if (response.status === 401 && token) saveSession(null);
    const message = (data as { message?: string | string[] } | null)?.message;
    throw new ApiError(
      response.status,
      Array.isArray(message) ? message.join('. ') : (message ?? `Request failed (${response.status}).`),
    );
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
