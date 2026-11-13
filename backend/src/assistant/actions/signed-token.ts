import { HttpException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A confirmation the browser can hold but not change: the request is written into the token and signed (HMAC-SHA256) with a key
 * derived from the server secret. `domain` separates one use from another, so a token made for one kind of confirmation is never
 * accepted by another. The caller checks who it is for and when it expires.
 */
export class TokenSigner {
  private readonly key: Buffer;

  constructor(secret: string, domain: string) {
    this.key = createHmac('sha256', secret).update(domain).digest();
  }

  sign(payload: object): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`;
  }

  /** The payload, only if the signature is genuine. Anything else is "not valid", with no detail about why. */
  verify(token: string): Record<string, unknown> {
    const invalid = () => new HttpException({ statusCode: 400, error: 'Bad Request', code: 'INVALID_CONFIRMATION', message: 'This confirmation is not valid.' }, 400);
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) throw invalid();
    const expected = createHmac('sha256', this.key).update(body).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
    try {
      const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid();
      return parsed as Record<string, unknown>;
    } catch {
      throw invalid();
    }
  }
}
