import { createSign, generateKeyPairSync } from 'node:crypto';
import { createClerkVerifier, devRejectionReasons, failureReasons, isServerSetupFailure, secretKeyProblem, tokenDiagnostics, verifiedEmailsOf } from './clerk-verifier.js';

const email = (id: string, emailAddress: string, status: string | null) => ({
  id,
  emailAddress,
  verification: status === null ? null : { status },
});

describe('verifiedEmailsOf', () => {
  it('returns only the addresses Clerk has verified', () => {
    const user = {
      primaryEmailAddressId: 'a',
      emailAddresses: [email('a', 'a@x.com', 'verified'), email('b', 'b@x.com', 'unverified'), email('c', 'c@x.com', null), email('d', 'd@x.com', 'expired')],
    };
    expect(verifiedEmailsOf(user)).toEqual(['a@x.com']);
  });

  it('puts the primary address first and lower-cases everything', () => {
    const user = {
      primaryEmailAddressId: 'b',
      emailAddresses: [email('a', 'First@X.com', 'verified'), email('b', 'Primary@X.COM', 'verified')],
    };
    expect(verifiedEmailsOf(user)).toEqual(['primary@x.com', 'first@x.com']);
  });

  it('removes duplicates and copes with having no verified address at all', () => {
    expect(
      verifiedEmailsOf({
        primaryEmailAddressId: null,
        emailAddresses: [email('a', 'Same@x.com', 'verified'), email('b', 'same@x.com', 'verified')],
      }),
    ).toEqual(['same@x.com']);
    expect(verifiedEmailsOf({ primaryEmailAddressId: null, emailAddresses: [email('a', 'a@x.com', 'unverified')] })).toEqual([]);
    expect(verifiedEmailsOf({ primaryEmailAddressId: null, emailAddresses: [] })).toEqual([]);
  });
});

describe('createClerkVerifier', () => {
  it('is a harmless stand-in when no Clerk key is configured: nothing verifies, nothing is let in', async () => {
    const verifier = createClerkVerifier({ enabled: false, secretKey: '', jwtKey: '', authorizedParties: [] });
    expect(verifier.enabled).toBe(false);
    expect(await verifier.verifySessionToken('anything')).toBeNull();
    expect(await verifier.getVerifiedEmails('user_1')).toEqual([]);
  });

  it('refuses tokens that are not valid Clerk tokens: never a user id', async () => {
    const verifier = createClerkVerifier({
      enabled: true,
      secretKey: 'sk_test_not_a_real_key',
      jwtKey: '',
      authorizedParties: ['http://localhost:3001'],
    });
    expect(verifier.enabled).toBe(true);
    // A refusal is null (production) or a 401 carrying the reason code (development); either way nobody is let in.
    for (const token of ['not-a-jwt', '']) {
      const outcome = await verifier.verifySessionToken(token).catch((error: unknown) => error);
      expect(typeof outcome).not.toBe('string');
      expect(outcome === null || (outcome as { getStatus?: () => number }).getStatus?.() === 401).toBe(true);
    }
  });
});

describe('telling server setup problems apart from bad tokens', () => {
  it('reads only the reason codes from Clerk errors', () => {
    expect(failureReasons([{ reason: 'token-expired', message: 'secret details' }, new Error('no reason'), { reason: 42 }])).toEqual(['token-expired']);
  });

  it.each(['secret-key-invalid', 'jwk-remote-failed-to-load', 'jwk-remote-invalid', 'jwk-remote-missing', 'jwk-failed-to-resolve', 'jwk-local-missing'])(
    'treats %s as a problem with the Clerk setup on the server',
    (reason) => {
      expect(isServerSetupFailure([reason])).toBe(true);
    },
  );

  it.each(['token-expired', 'token-invalid', 'token-invalid-signature', 'token-invalid-authorized-parties', 'token-not-active-yet', 'jwk-kid-mismatch'])(
    'treats %s as a bad token, so the person is asked to sign in again',
    (reason) => {
      expect(isServerSetupFailure([reason])).toBe(false);
    },
  );

  it('does not treat having no reason as a setup problem', () => {
    expect(isServerSetupFailure([])).toBe(false);
  });
});

describe('secretKeyProblem', () => {
  it('accepts a full-looking key', () => {
    expect(secretKeyProblem(`sk_test_${'a1B2'.repeat(10)}`)).toBeNull();
  });

  it.each(['sk_test_abc…', 'sk_test_...', '', 'pk_test_' + 'a'.repeat(30), `"sk_test_${'a'.repeat(30)}"`, `sk_test_${'a'.repeat(30)} `])(
    'flags %j',
    (key) => {
      expect(secretKeyProblem(key)).not.toBeNull();
    },
  );
});

describe('tokenDiagnostics', () => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

  it('reports only the origin and the time left, never the token', () => {
    const token = `${part({ alg: 'RS256' })}.${part({ azp: 'http://localhost:3001', exp: 1100, sub: 'user_secret', sid: 'sess_secret' })}.signature-part`;
    const text = tokenDiagnostics(token, 1000);
    expect(text).toBe('azp=http://localhost:3001, expires in 100s');
    expect(text).not.toMatch(/user_secret|sess_secret|signature-part/);
  });

  it('shows a negative time for an expired token and copes with garbage', () => {
    expect(tokenDiagnostics(`${part({})}.${part({ exp: 900 })}.x`, 1000)).toBe('azp=none, expires in -100s');
    expect(tokenDiagnostics('not-a-token')).toBe('token payload unreadable');
  });
});

describe('devRejectionReasons', () => {
  it('shows reason codes in development and nothing in production', () => {
    expect(devRejectionReasons(['token-invalid-authorized-parties', 'token-expired'], false)).toBe('token-invalid-authorized-parties,token-expired');
    expect(devRejectionReasons(['token-expired'], true)).toBeUndefined();
    expect(devRejectionReasons([], false)).toBeUndefined();
  });
});

describe('verifying real signed session tokens (no network: the public key is supplied)', () => {
  const origin = 'http://localhost:3001';
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const sign = (claims: Record<string, unknown>, privateKey = keys.privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    const body = { sub: 'user_abc123', azp: origin, iat: now - 5, nbf: now - 5, exp: now + 60, ...claims };
    const signing = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'ins_test' })}.${b64(body)}`;
    return `${signing}.${createSign('RSA-SHA256').update(signing).sign(privateKey).toString('base64url')}`;
  };
  const verifier = () => createClerkVerifier({ enabled: true, secretKey: `sk_test_${'a'.repeat(30)}`, jwtKey: publicPem, authorizedParties: [origin] });
  /** The user id, or null when refused (a development refusal is a 401 error, which counts as refused too). */
  const outcome = async (token: string) => verifier().verifySessionToken(token).catch((error: { getStatus?: () => number }) => (error.getStatus?.() === 401 ? null : error));

  it('accepts a valid token and returns the Clerk user id', async () => {
    expect(await outcome(sign({}))).toBe('user_abc123');
  });

  it('refuses a token issued for a different origin', async () => {
    expect(await outcome(sign({ azp: 'http://evil.example' }))).toBeNull();
  });

  it('refuses an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(await outcome(sign({ iat: past - 60, nbf: past - 60, exp: past }))).toBeNull();
  });

  it('refuses a token signed with a different key', async () => {
    expect(await outcome(sign({}, otherKeys.privateKey))).toBeNull();
  });

  it('refuses a token with no subject', async () => {
    expect(await outcome(sign({ sub: '' }))).toBeNull();
  });

  it('refuses a tampered payload', async () => {
    const [header, , signature] = sign({}).split('.');
    expect(await outcome(`${header}.${b64({ sub: 'user_other', azp: origin, exp: 9999999999, iat: 1, nbf: 1 })}.${signature}`)).toBeNull();
  });
});
