/**
 * Integration tests: real PostgreSQL, full HTTP stack via Fastify inject.
 *
 * These tests require a running PostgreSQL instance. They are skipped
 * automatically when TEST_DATABASE_URL is not set, so the standard
 * `npm test` run passes without Docker.
 *
 * To run locally:
 *   TEST_DATABASE_URL="postgresql://flowboard:flowboard_local@localhost:5432/flowboard" \
 *     npm test --workspace @flowboard/api
 *
 * Each suite gets its own isolated Postgres schema (search_path) so tests
 * do not interfere with the seed database or with each other.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from './app.js';

// ── helpers ────────────────────────────────────────────────────────────────

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const skip = !TEST_DATABASE_URL;

/**
 * Create a throwaway Postgres schema for one test suite, apply migrations,
 * and return a PrismaClient scoped to that schema.
 *
 * Why per-suite schemas?
 *   PostgreSQL schemas are cheap namespace containers. By giving each suite
 *   its own schema we can run migrations once per suite, insert only the
 *   fixtures that suite needs, and tear down without affecting other suites
 *   or the development seed data.
 */
async function createTestSchema(baseUrl: string) {
  const schema = `test_${randomUUID().replaceAll('-', '_')}`;
  const schemaUrl = `${baseUrl}?schema=${schema}`;

  // Create the schema and run migrations into it
  const adminClient = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  await adminClient.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await adminClient.$disconnect();

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: schemaUrl },
    cwd: new URL('../../../../', import.meta.url).pathname,
    stdio: 'pipe',
  });

  const prisma = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
  return { prisma, schema, schemaUrl };
}

async function dropTestSchema(baseUrl: string, schema: string) {
  const adminClient = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  await adminClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await adminClient.$disconnect();
}

/** Minimal fixture — workspace + two users (admin + member). */
async function seedMinimal(prisma: PrismaClient) {
  const alice = await prisma.user.create({ data: { userKey: 'alice', displayName: 'Alice Chen', role: 'admin' } });
  const bob = await prisma.user.create({ data: { userKey: 'bob', displayName: 'Bob Rivera', role: 'member' } });
  const workspace = await prisma.container.create({ data: { type: 'workspace', name: 'Test Workspace', visibility: 'public' } });

  // Workspace-level default statuses (must cover not_started / active / done)
  const [todo, inProgress, done] = await Promise.all([
    prisma.statusDefinition.create({ data: { ownerId: workspace.id, key: 'todo', name: 'To do', category: 'not_started', color: '#aaa', position: 0 } }),
    prisma.statusDefinition.create({ data: { ownerId: workspace.id, key: 'in_progress', name: 'In progress', category: 'active', color: '#5b8def', position: 1 } }),
    prisma.statusDefinition.create({ data: { ownerId: workspace.id, key: 'done', name: 'Done', category: 'done', color: '#26a269', position: 2 } }),
  ]);

  return { alice, bob, workspace, statuses: { todo, inProgress, done } };
}

// ── suite 1: access control ────────────────────────────────────────────────

describe.skipIf(skip)('access control (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let schema: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ({ prisma, schema } = await createTestSchema(TEST_DATABASE_URL!));
    app = await buildApp({ logger: false, testDatabaseUrl: `${TEST_DATABASE_URL}?schema=${schema}` });
  });

  afterEach(async () => {
    // Truncate between tests to keep fixtures independent
    await prisma.$executeRawUnsafe('TRUNCATE "ContainerGrant","Task","TaskAssignee","StatusDefinition","CustomFieldDefinition","Container","User" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await dropTestSchema(TEST_DATABASE_URL!, schema);
  });

  it('returns 403 when a member requests a private list they have no grant for', async () => {
    const { bob, workspace } = await seedMinimal(prisma);
    const space = await prisma.container.create({ data: { type: 'space', name: 'Engineering', parentId: workspace.id } });
    const folder = await prisma.container.create({ data: { type: 'folder', name: 'Q2', parentId: space.id } });
    const privateList = await prisma.container.create({ data: { type: 'list', name: 'Secret', parentId: folder.id, visibility: 'private' } });

    const response = await app.inject({ method: 'GET', url: `/v1/lists/${privateList.id}/resolved-statuses`, headers: { 'x-user-id': bob.userKey } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('returns 403 when a member is explicitly denied on an ancestor', async () => {
    const { bob, workspace } = await seedMinimal(prisma);
    const space = await prisma.container.create({ data: { type: 'space', name: 'Engineering', parentId: workspace.id } });
    // Grant bob on the space then deny him — deny wins
    await prisma.containerGrant.create({ data: { containerId: space.id, userId: bob.id, mode: 'deny' } });
    const folder = await prisma.container.create({ data: { type: 'folder', name: 'Q2', parentId: space.id } });
    const list = await prisma.container.create({ data: { type: 'list', name: 'Backlog', parentId: folder.id } });
    // Even with an allow on the list itself, the ancestor deny wins
    await prisma.containerGrant.create({ data: { containerId: list.id, userId: bob.id, mode: 'allow' } });

    const response = await app.inject({ method: 'GET', url: `/v1/lists/${list.id}/resolved-statuses`, headers: { 'x-user-id': bob.userKey } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('allows a member with an explicit allow grant to read private list tasks', async () => {
    const { bob, workspace, statuses } = await seedMinimal(prisma);
    const space = await prisma.container.create({ data: { type: 'space', name: 'Engineering', parentId: workspace.id } });
    const folder = await prisma.container.create({ data: { type: 'folder', name: 'Q2', parentId: space.id } });
    const list = await prisma.container.create({ data: { type: 'list', name: 'Backlog', parentId: folder.id, visibility: 'private' } });
    await prisma.containerGrant.create({ data: { containerId: list.id, userId: bob.id, mode: 'allow' } });
    await prisma.task.create({ data: { primaryListId: list.id, statusId: statuses.todo.id, title: 'Granted task', position: 0 } });

    const response = await app.inject({ method: 'GET', url: `/v1/lists/${list.id}/tasks`, headers: { 'x-user-id': bob.userKey } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
  });

  it('returns 404 for a task in a list the user cannot see', async () => {
    const { bob, workspace, statuses } = await seedMinimal(prisma);
    const space = await prisma.container.create({ data: { type: 'space', name: 'Product', parentId: workspace.id } });
    const folder = await prisma.container.create({ data: { type: 'folder', name: 'Discovery', parentId: space.id } });
    const privateList = await prisma.container.create({ data: { type: 'list', name: 'Roadmap', parentId: folder.id, visibility: 'private' } });
    const task = await prisma.task.create({ data: { primaryListId: privateList.id, statusId: statuses.todo.id, title: 'Hidden task', position: 0 } });

    // Bob has no grant — trying to fetch the task directly should 403 (access check on task's list)
    const response = await app.inject({ method: 'GET', url: `/v1/tasks/${task.id}`, headers: { 'x-user-id': bob.userKey } });
    expect(response.statusCode).toBe(403);
  });

  it('returns 403 when a member tries to create a container', async () => {
    const { bob } = await seedMinimal(prisma);
    const response = await app.inject({
      method: 'POST', url: '/v1/containers',
      headers: { 'x-user-id': bob.userKey, 'content-type': 'application/json' },
      payload: { name: 'Sneaky Space', type: 'space' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });
});

// ── suite 2: task validation and cross-list move ───────────────────────────

describe.skipIf(skip)('task validation and cross-list move (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let schema: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ({ prisma, schema } = await createTestSchema(TEST_DATABASE_URL!));
    app = await buildApp({ logger: false, testDatabaseUrl: `${TEST_DATABASE_URL}?schema=${schema}` });
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "ContainerGrant","Task","TaskAssignee","StatusDefinition","CustomFieldDefinition","Container","User" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await dropTestSchema(TEST_DATABASE_URL!, schema);
  });

  it('rejects a task creation with an unknown statusId', async () => {
    const { workspace } = await seedMinimal(prisma);
    const space = await prisma.container.create({ data: { type: 'space', name: 'Eng', parentId: workspace.id } });
    const folder = await prisma.container.create({ data: { type: 'folder', name: 'Q2', parentId: space.id } });
    const list = await prisma.container.create({ data: { type: 'list', name: 'Backlog', parentId: folder.id } });

    const response = await app.inject({
      method: 'POST', url: `/v1/lists/${list.id}/tasks`,
      headers: { 'x-user-id': 'alice', 'content-type': 'application/json' },
      payload: { title: 'Bad task', statusId: 'nonexistent-status-id' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a task creation missing a required custom field', async () => {
    const { workspace, statuses } = await seedMinimal(prisma);
    const space = await prisma.container.create({ data: { type: 'space', name: 'Eng', parentId: workspace.id } });
    // Add a required field at space level
    await prisma.customFieldDefinition.create({ data: { ownerId: space.id, key: 'estimate', name: 'Estimate', type: 'number', required: true, position: 0, options: [] } });
    const folder = await prisma.container.create({ data: { type: 'folder', name: 'Q2', parentId: space.id } });
    const list = await prisma.container.create({ data: { type: 'list', name: 'Backlog', parentId: folder.id } });

    const response = await app.inject({
      method: 'POST', url: `/v1/lists/${list.id}/tasks`,
      headers: { 'x-user-id': 'alice', 'content-type': 'application/json' },
      payload: { title: 'Missing estimate', statusId: statuses.todo.id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'customFields.estimate' })]),
    );
  });

  it('rejects a cross-list move when destination status is unavailable', async () => {
    const { alice, workspace } = await seedMinimal(prisma);
    const space = await prisma.container.create({ data: { type: 'space', name: 'Eng', parentId: workspace.id } });
    const folder = await prisma.container.create({ data: { type: 'folder', name: 'Q2', parentId: space.id } });
    const source = await prisma.container.create({ data: { type: 'list', name: 'Backlog', parentId: folder.id } });
    const dest = await prisma.container.create({ data: { type: 'list', name: 'Delivery', parentId: folder.id, position: 1 } });

    // Add a status only to source — not available in dest
    const sourceOnlyStatus = await prisma.statusDefinition.create({
      data: { ownerId: source.id, key: 'source_only', name: 'Source only', category: 'active', color: '#f00', position: 3 },
    });
    const task = await prisma.task.create({
      data: { primaryListId: source.id, statusId: sourceOnlyStatus.id, title: 'Move me', position: 0 },
    });

    // Move without providing a new statusId — dest doesn't have source_only
    const response = await app.inject({
      method: 'POST', url: `/v1/tasks/${task.id}/move`,
      headers: { 'x-user-id': alice.userKey, 'content-type': 'application/json' },
      payload: { destinationListId: dest.id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'statusId' })]),
    );
  });

  it('succeeds when cross-list move supplies a valid destination status', async () => {
    const { alice, workspace, statuses } = await seedMinimal(prisma);
    const space = await prisma.container.create({ data: { type: 'space', name: 'Eng', parentId: workspace.id } });
    const folder = await prisma.container.create({ data: { type: 'folder', name: 'Q2', parentId: space.id } });
    const source = await prisma.container.create({ data: { type: 'list', name: 'Backlog', parentId: folder.id } });
    const dest = await prisma.container.create({ data: { type: 'list', name: 'Delivery', parentId: folder.id, position: 1 } });

    const task = await prisma.task.create({
      data: { primaryListId: source.id, statusId: statuses.inProgress.id, title: 'Move me', position: 0 },
    });

    const response = await app.inject({
      method: 'POST', url: `/v1/tasks/${task.id}/move`,
      headers: { 'x-user-id': alice.userKey, 'content-type': 'application/json' },
      payload: { destinationListId: dest.id, statusId: statuses.todo.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.primaryListId).toBe(dest.id);
    expect(response.json().data.statusId).toBe(statuses.todo.id);
  });
});

// ── suite 3: configuration guard (in-use status blocks disable) ────────────

describe.skipIf(skip)('configuration guard (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let schema: string;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ({ prisma, schema } = await createTestSchema(TEST_DATABASE_URL!));
    app = await buildApp({ logger: false, testDatabaseUrl: `${TEST_DATABASE_URL}?schema=${schema}` });
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "ContainerGrant","Task","TaskAssignee","StatusDefinition","CustomFieldDefinition","Container","User" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await dropTestSchema(TEST_DATABASE_URL!, schema);
  });

  it('blocks adding a disabled status override when tasks use that key in a descendant list', async () => {
    const { workspace, statuses } = await seedMinimal(prisma);
    const space = await prisma.container.create({ data: { type: 'space', name: 'Eng', parentId: workspace.id } });
    const folder = await prisma.container.create({ data: { type: 'folder', name: 'Q2', parentId: space.id } });
    const list = await prisma.container.create({ data: { type: 'list', name: 'Backlog', parentId: folder.id } });
    // Create a task using the workspace 'in_progress' status
    await prisma.task.create({ data: { primaryListId: list.id, statusId: statuses.inProgress.id, title: 'Active task', position: 0 } });

    // Try to override in_progress at the space level with disabled:true
    const response = await app.inject({
      method: 'POST', url: `/v1/lists/${space.id}/statuses`,
      headers: { 'x-user-id': 'alice', 'content-type': 'application/json' },
      payload: { key: 'in_progress', name: 'In progress', category: 'active', color: '#000', disabled: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('STATUS_IN_USE');
  });

  it('allows a status override when no tasks use that key', async () => {
    const { workspace } = await seedMinimal(prisma);
    const space = await prisma.container.create({ data: { type: 'space', name: 'Eng', parentId: workspace.id } });
    const folder = await prisma.container.create({ data: { type: 'folder', name: 'Q2', parentId: space.id } });
    await prisma.container.create({ data: { type: 'list', name: 'Empty', parentId: folder.id } });

    // Override 'todo' at space level (no tasks use it yet)
    const response = await app.inject({
      method: 'POST', url: `/v1/lists/${space.id}/statuses`,
      headers: { 'x-user-id': 'alice', 'content-type': 'application/json' },
      payload: { key: 'todo', name: 'Backlog', category: 'not_started', color: '#8492a6' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.key).toBe('todo');
  });

  it('returns paginated tasks with cursor navigation', async () => {
    const { workspace, statuses } = await seedMinimal(prisma);
    const space = await prisma.container.create({ data: { type: 'space', name: 'Eng', parentId: workspace.id } });
    const folder = await prisma.container.create({ data: { type: 'folder', name: 'Q2', parentId: space.id } });
    const list = await prisma.container.create({ data: { type: 'list', name: 'Big list', parentId: folder.id } });
    // Create 5 tasks
    for (let i = 0; i < 5; i++) {
      await prisma.task.create({ data: { primaryListId: list.id, statusId: statuses.todo.id, title: `Task ${i}`, position: i } });
    }

    const page1 = await app.inject({ method: 'GET', url: `/v1/lists/${list.id}/tasks?limit=3`, headers: { 'x-user-id': 'alice' } });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.data).toHaveLength(3);
    expect(body1.pageInfo.hasMore).toBe(true);
    expect(body1.pageInfo.nextCursor).toBeTruthy();

    const page2 = await app.inject({ method: 'GET', url: `/v1/lists/${list.id}/tasks?limit=3&cursor=${body1.pageInfo.nextCursor}`, headers: { 'x-user-id': 'alice' } });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json();
    expect(body2.data).toHaveLength(2);
    expect(body2.pageInfo.hasMore).toBe(false);
  });
});
