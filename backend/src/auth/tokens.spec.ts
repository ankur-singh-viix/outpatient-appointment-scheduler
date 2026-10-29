import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { bearerToken, isLegacyToken } from './tokens.js';

const jwt = new JwtService({ secret: 'unit-test-secret' });
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsigned = (alg: string) => `${b64({ alg, typ: 'JWT' })}.${b64({ sub: 'user_1' })}.signature`;
const requestWith = (authorization?: string) => ({ headers: { authorization } }) as unknown as Request;

describe('isLegacyToken', () => {
  it('recognises tokens signed with our own secret', async () => {
    expect(isLegacyToken(jwt, await jwt.signAsync({ sub: 'u1' }))).toBe(true);
  });

  it('sends anything that is not HS256 down the Clerk path, where its signature is checked', () => {
    expect(isLegacyToken(jwt, unsigned('RS256'))).toBe(false);
    expect(isLegacyToken(jwt, unsigned('none'))).toBe(false);
    expect(isLegacyToken(jwt, unsigned('ES256'))).toBe(false);
  });

  it('does not treat garbage as a legacy token', () => {
    expect(isLegacyToken(jwt, 'not-a-jwt')).toBe(false);
    expect(isLegacyToken(jwt, '')).toBe(false);
    expect(isLegacyToken(jwt, 'a.b.c')).toBe(false);
  });
});

describe('bearerToken', () => {
  it('reads a Bearer token', () => {
    expect(bearerToken(requestWith('Bearer abc.def.ghi'))).toBe('abc.def.ghi');
  });

  it('ignores other schemes and missing or empty headers', () => {
    expect(bearerToken(requestWith('Basic abc'))).toBeNull();
    expect(bearerToken(requestWith('Bearer'))).toBeNull();
    expect(bearerToken(requestWith(''))).toBeNull();
    expect(bearerToken(requestWith(undefined))).toBeNull();
  });
});
