import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { prisma } from '../db.js';

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

  it('returns malformed request bodies as 400 with field details instead of 500', async () => {
    const findUser = vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({
      id: 'user-alice', userKey: 'alice', displayName: 'Alice Chen', role: 'admin', createdAt: new Date(),
    });
    const app = await appPromise;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/containers',
      headers: { 'x-user-id': 'alice' },
      payload: { name: '', type: 'space' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(response.json().error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'name' }),
    ]));
    findUser.mockRestore();
  });
});

afterAll(async () => {
  const app = await appPromise;
  await app.close();
});
