import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { PinAttempts } from '../../../src/features/idp/step-up.js';
import { buildTestApp, loginCookie, TEST_ISSUER } from '../../support/build-app.js';

const DRAFT = {
  draft_id: 'drf_0b3a6f9e-4c1d-4e2a-9f7b-1a2b3c4d5e6f',
  amount: '50000.00',
  currency: 'ARS',
  beneficiary_id: 'ben-juan-ana',
};

async function setup() {
  const { app } = await buildTestApp();
  const cookie = await loginCookie(app, 'juan');
  const stepUp = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('/auth/step-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: JSON.stringify(body),
    });
  return { app, cookie, stepUp };
}

describe('POST /auth/step-up', () => {
  it('issues a 2-minute, mcp-payments token bound to exactly the confirmed draft', async () => {
    const { app, stepUp } = await setup();
    const res = await stepUp({ ...DRAFT, pin: '123456' });
    expect(res.status).toBe(200);
    const { step_up_token: token, expires_in } = (await res.json()) as { step_up_token: string; expires_in: number };
    expect(expires_in).toBe(120);
    const jwks = createLocalJWKSet(await (await app.request('/.well-known/jwks.json')).json());
    const { payload } = await jwtVerify(token, jwks, { issuer: TEST_ISSUER, audience: 'mcp-payments' });
    expect(payload).toMatchObject({
      sub: 'juan',
      token_use: 'step_up',
      scope: 'transfers:execute',
      authorization_details: [{ type: 'transfer', ...DRAFT }],
    });
    expect(payload.jti).toBeTruthy();
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(120);
    // Not an exchanged access token: MCP servers require `act` on those, so this can't be used as one.
    expect(payload.act).toBeUndefined();
  });

  it('rejects a wrong PIN', async () => {
    const { stepUp } = await setup();
    expect((await stepUp({ ...DRAFT, pin: '000000' })).status).toBe(401);
  });

  it('locks step-up after three wrong PINs, even for the right one', async () => {
    const { stepUp } = await setup();
    for (let i = 0; i < 3; i++) await stepUp({ ...DRAFT, pin: '000000' });
    expect((await stepUp({ ...DRAFT, pin: '123456' })).status).toBe(429);
  });

  it('holds concurrent wrong PINs to three guesses, and keeps the lock for the right one after', async () => {
    const { app, cookie, stepUp } = await setup();
    // Each body arrives only once every request has passed the session check, so all six are in flight together.
    let release!: () => void;
    const bodiesSent = new Promise<void>((resolve) => (release = resolve));
    const heldBody = () =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          await bodiesSent;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...DRAFT, pin: '000000' })));
          controller.close();
        },
      });
    const inFlight = Array.from({ length: 6 }, () =>
      app.request('/auth/step-up', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: heldBody(),
        duplex: 'half',
      } as RequestInit),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const statuses = (await Promise.all(inFlight)).map((res) => res.status);
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(3);
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
    expect((await stepUp({ ...DRAFT, pin: '123456' })).status).toBe(429);
  });

  it.each([
    ['a malformed draft id', { ...DRAFT, draft_id: 'drf_x', pin: '123456' }],
    ['a free-text amount', { ...DRAFT, amount: 'cincuenta mil', pin: '123456' }],
    ['a short PIN', { ...DRAFT, pin: '1234' }],
  ])('rejects %s', async (_, body) => {
    const { stepUp } = await setup();
    expect((await stepUp(body)).status).toBe(400);
  });

  it('requires a session', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/auth/step-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...DRAFT, pin: '123456' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('PinAttempts', () => {
  const MINUTE = 60_000;
  const at = (minutes: number, seconds = 0) => minutes * MINUTE + seconds * 1000;

  it('locks for five minutes from the third failure, however long the first one was before it', () => {
    let clock = 0;
    const attempts = new PinAttempts(() => clock);
    for (const t of [at(0), at(4, 58), at(4, 59)]) {
      clock = t;
      attempts.fail('juan');
    }
    clock = at(5);
    expect(attempts.locked('juan')).toBe(true);
    clock = at(9, 58);
    expect(attempts.locked('juan')).toBe(true);
    clock = at(9, 59);
    expect(attempts.locked('juan')).toBe(false);
  });

  it('forgets failures older than the 15-minute window', () => {
    let clock = 0;
    const attempts = new PinAttempts(() => clock);
    attempts.fail('juan');
    clock = at(1);
    attempts.fail('juan');
    clock = at(20);
    attempts.fail('juan');
    expect(attempts.locked('juan')).toBe(false);
  });

  it('locks on three failures within the window, counted from the first', () => {
    let clock = 0;
    const attempts = new PinAttempts(() => clock);
    for (const t of [at(0), at(10), at(14, 59)]) {
      clock = t;
      attempts.fail('juan');
    }
    expect(attempts.locked('juan')).toBe(true);
  });

  it('starts a new window at the first failure after the old one ended', () => {
    let clock = 0;
    const attempts = new PinAttempts(() => clock);
    attempts.fail('juan');
    attempts.fail('juan');
    for (const t of [at(16), at(17), at(18)]) {
      clock = t;
      attempts.fail('juan');
    }
    expect(attempts.locked('juan')).toBe(true);
  });

  it('starts a fresh count once the lock lifts', () => {
    let clock = 0;
    const attempts = new PinAttempts(() => clock);
    for (let i = 0; i < 3; i++) attempts.fail('juan');
    clock = at(5);
    expect(attempts.locked('juan')).toBe(false);
    attempts.fail('juan');
    expect(attempts.locked('juan')).toBe(false);
  });

  it('keeps the lock when a failure lands while it is active', () => {
    const attempts = new PinAttempts(() => 0);
    for (let i = 0; i < 4; i++) attempts.fail('juan');
    expect(attempts.locked('juan')).toBe(true);
  });

  it('restarts the five minutes from a failure that lands during the lock', () => {
    let clock = 0;
    const attempts = new PinAttempts(() => clock);
    for (let i = 0; i < 3; i++) attempts.fail('juan');
    clock = at(4);
    attempts.fail('juan');
    clock = at(8, 59);
    expect(attempts.locked('juan')).toBe(true);
    clock = at(9);
    expect(attempts.locked('juan')).toBe(false);
  });

  it('starts a fresh count after a served lock even if nobody checked it', () => {
    let clock = 0;
    const attempts = new PinAttempts(() => clock);
    for (let i = 0; i < 3; i++) attempts.fail('juan');
    clock = at(6);
    attempts.fail('juan');
    expect(attempts.locked('juan')).toBe(false);
  });

  it('does not lock before the third failure, and a success clears the count', () => {
    const attempts = new PinAttempts(() => 0);
    attempts.fail('juan');
    attempts.fail('juan');
    expect(attempts.locked('juan')).toBe(false);
    attempts.reset('juan');
    attempts.fail('juan');
    expect(attempts.locked('juan')).toBe(false);
  });
});
