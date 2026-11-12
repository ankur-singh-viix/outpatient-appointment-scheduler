/** Thrown when a request was given a time limit and did not finish in it. */
export class RequestTimeoutError extends Error {
  constructor() {
    super('The request took too long.');
    this.name = 'RequestTimeoutError';
  }
}

/** fetch with an optional time limit (the whole request, answer included). Without a limit it is plain fetch. */
export async function fetchWithTimeout(fetchFn: typeof fetch, url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  if (!timeoutMs) return fetchFn(url, init);
  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new RequestTimeoutError();
    throw error;
  }
}
