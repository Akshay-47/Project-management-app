import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const appPromise = buildApp({ logger: false });

describe('HTTP boundary', () => {
  it('exposes health and API discovery without a user identity', async () => {
    const app = await appPromise;
    const health = await app.inject({ method: 'GET', url: '/health' });
    const discovery = await app.inject({ method: 'GET', url: '/v1' });
    expect(health.statusCode).toBe(200);
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json().version).toBe('v1');
  });

  it('rejects protected requests without a user identity using a stable JSON error', async () => {
    const app = await appPromise;
    const response = await app.inject({ method: 'GET', url: '/v1/containers/tree' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Send x-user-id with a seeded user ID.' },
    });
  });
});

afterAll(async () => {
  const app = await appPromise;
  await app.close();
});
