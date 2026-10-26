import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { prisma as defaultPrisma } from '../db.js';
import { canAccessContainerChain } from '../domain/authorization.js';
import { hasRequiredStatusCategories, resolveFields, resolveStatuses } from '../domain/configuration.js';
import { validateTaskConfiguration } from '../domain/task-validation.js';
import { AppError } from './errors.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const USER_HEADER = 'x-user-id';
const priorityValues = ['urgent', 'high', 'normal', 'low', 'none'] as const;
const containerTypes = ['space', 'folder', 'list'] as const;

const createContainerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(containerTypes),
  parentId: z.string().nullable().optional(),
  position: z.number().int().min(0).optional(),
  visibility: z.enum(['public', 'private']).optional(),
});
const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(20_000).nullable().optional(),
  statusId: z.string(),
  priority: z.enum(priorityValues).optional(),
  dueDate: z.string().datetime().nullable().optional(),
  assigneeIds: z.array(z.string()).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});
const updateTaskSchema = createTaskSchema.partial().extend({
  primaryListId: z.string().optional(),
  position: z.number().int().min(0).optional(),
});

const parentType: Record<string, string | null> = {
  workspace: null,
  space: 'workspace',
  folder: 'space',
  list: 'folder',
};

type RequestWithUser = FastifyRequest & { currentUser?: { id: string; userKey: string; displayName: string; role: 'admin' | 'member' } };
type ContainerWithGrants = Prisma.ContainerGetPayload<{ include: { grants: true } }>;

function badRequest(message: string, details?: unknown): never {
  throw new AppError(400, 'VALIDATION_ERROR', message, details);
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) badRequest('Request validation failed.', result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  return result.data;
}

// ── DB-aware helpers (accept explicit PrismaClient so tests can inject their own) ──

async function requireContainerAccess(db: PrismaClient, user: NonNullable<RequestWithUser['currentUser']>, containerId: string) {
  const chain: ContainerWithGrants[] = [];
  let currentId: string | null = containerId;
  while (currentId) {
    const current: ContainerWithGrants | null = await db.container.findUnique({ where: { id: currentId }, include: { grants: true } });
    if (!current || current.archivedAt) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Container was not found.');
    chain.unshift(current);
    currentId = current.parentId;
  }
  if (!canAccessContainerChain(user.role, user.id, chain)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have access to this container or one of its ancestors.');
  }
  return chain;
}

async function requireCanEdit(db: PrismaClient, user: NonNullable<RequestWithUser['currentUser']>, containerId: string) {
  await requireContainerAccess(db, user, containerId);
  if (user.role === 'admin') return;
  const container = await db.container.findUnique({ where: { id: containerId }, include: { grants: true } });
  if (!container || container.archivedAt) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Container was not found.');
  // Members with access may edit tasks in the granted list; configuration remains administrator-only.
  if (container.type !== 'list') throw new AppError(403, 'FORBIDDEN', 'Only workspace admins can change container configuration.');
}

async function resolvedConfiguration(db: PrismaClient, listId: string) {
  const chain = await db.container.findUnique({ where: { id: listId } });
  if (!chain || chain.type !== 'list' || chain.archivedAt) throw new AppError(404, 'LIST_NOT_FOUND', 'List was not found.');
  const ancestors = [chain];
  let cursor = chain;
  while (cursor.parentId) {
    const parent = await db.container.findUnique({ where: { id: cursor.parentId } });
    if (!parent) throw new AppError(409, 'INVALID_HIERARCHY', 'List hierarchy is incomplete.');
    ancestors.unshift(parent);
    cursor = parent;
  }
  const ownerIds = ancestors.map((node) => node.id);
  const [statusDefinitions, fieldDefinitions] = await Promise.all([
    db.statusDefinition.findMany({ where: { ownerId: { in: ownerIds } }, orderBy: { position: 'asc' } }),
    db.customFieldDefinition.findMany({ where: { ownerId: { in: ownerIds }, archivedAt: null }, orderBy: { position: 'asc' } }),
  ]);
  const order = new Map(ownerIds.map((id, index) => [id, index]));
  const orderedStatuses = [...statusDefinitions].sort((a, b) => (order.get(a.ownerId) ?? 0) - (order.get(b.ownerId) ?? 0));
  const orderedFields = [...fieldDefinitions].sort((a, b) => (order.get(a.ownerId) ?? 0) - (order.get(b.ownerId) ?? 0));
  const statuses = resolveStatuses(orderedStatuses.map((definition) => ({ ownerId: definition.ownerId, definition })));
  const fields = resolveFields(orderedFields.map((definition) => ({
    ownerId: definition.ownerId,
    definition: { ...definition, options: Array.isArray(definition.options) ? definition.options as Array<{ id: string; label: string; color?: string }> : [] },
  })));
  return { list: chain, ancestors, statuses, fields };
}

async function descendantListIds(db: PrismaClient, ownerId: string) {
  const containers = await db.container.findMany({ where: { archivedAt: null }, select: { id: true, parentId: true, type: true } });
  const descendantIds = new Set([ownerId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const container of containers) {
      if (container.parentId && descendantIds.has(container.parentId) && !descendantIds.has(container.id)) {
        descendantIds.add(container.id);
        changed = true;
      }
    }
  }
  return containers
    .filter((container) => container.type === 'list' && descendantIds.has(container.id))
    .map((container) => container.id);
}

async function statusKeyIsInUse(db: PrismaClient, ownerId: string, key: string) {
  const listIds = await descendantListIds(db, ownerId);
  const definitions = await db.statusDefinition.findMany({ where: { key }, select: { id: true } });
  if (!listIds.length || !definitions.length) return false;
  return Boolean(await db.task.findFirst({
    where: { primaryListId: { in: listIds }, statusId: { in: definitions.map((item) => item.id) }, archivedAt: null },
    select: { id: true },
  }));
}

async function fieldKeyIsInUse(db: PrismaClient, ownerId: string, key: string, required: boolean) {
  const listIds = await descendantListIds(db, ownerId);
  if (!listIds.length) return false;
  const tasks = await db.task.findMany({ where: { primaryListId: { in: listIds }, archivedAt: null }, select: { customValues: true } });
  return tasks.some((task) => required || (
    task.customValues !== null &&
    typeof task.customValues === 'object' &&
    !Array.isArray(task.customValues) &&
    Object.hasOwn(task.customValues, key)
  ));
}

async function visibleTree(db: PrismaClient, user: NonNullable<RequestWithUser['currentUser']>) {
  const all = await db.container.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }], include: { grants: true } });
  const byId = new Map(all.map((container) => [container.id, container]));
  const visible = new Set<string>();
  for (const container of all) {
    const chain: typeof all = [];
    let cursor: (typeof all)[number] | undefined = container;
    while (cursor) {
      chain.unshift(cursor);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    if (canAccessContainerChain(user.role, user.id, chain)) visible.add(container.id);
  }
  return all
    .filter((container) => !container.archivedAt && visible.has(container.id))
    .map(({ grants: _grants, ...container }) => container);
}

// ── App factory ────────────────────────────────────────────────────────────

export async function buildApp(options: { logger?: boolean; testDatabaseUrl?: string } = {}) {
  // Use a test-scoped Prisma client when a test database URL is supplied,
  // otherwise fall back to the global singleton from db.ts.
  const prisma = options.testDatabaseUrl
    ? new PrismaClient({ datasources: { db: { url: options.testDatabaseUrl } } })
    : defaultPrisma;

  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 1_048_576 });
  const allowedOrigins = new Set((process.env.CORS_ORIGINS ?? 'http://localhost:8080,http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean));
  await app.register(helmet);
  await app.register(cors, {
    origin: (origin, callback) => callback(null, origin === undefined || allowedOrigins.has(origin)),
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.status(400).send({ error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      } });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } });
  });

  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'OPTIONS' || request.url === '/health' || request.url === '/v1') return;
    const userKey = request.headers[USER_HEADER];
    if (typeof userKey !== 'string' || !userKey.trim()) {
      await reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: `Send ${USER_HEADER} with a seeded user ID.` } });
      return;
    }
    const user = await prisma.user.findUnique({ where: { userKey }, select: { id: true, userKey: true, displayName: true, role: true } });
    if (!user) {
      await reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'The supplied user identity is not recognized.' } });
      return;
    }
    (request as RequestWithUser).currentUser = user;
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/v1', async () => ({
    name: 'Flowboard API', version: 'v1',
    endpoints: [
      'GET /v1/me', 'GET /v1/containers/tree', 'POST /v1/containers', 'PATCH /v1/containers/:id',
      'POST /v1/containers/:id/archive', 'GET /v1/lists/:id/resolved-statuses', 'GET /v1/lists/:id/resolved-fields',
      'POST /v1/lists/:id/statuses', 'POST /v1/lists/:id/fields', 'GET /v1/lists/:id/tasks', 'POST /v1/lists/:id/tasks',
      'GET /v1/tasks/:id', 'PATCH /v1/tasks/:id', 'POST /v1/tasks/:id/move', 'POST /v1/tasks/:id/archive',
    ],
    errors: { shape: '{ error: { code, message, details? } }' },
  }));

  app.get('/v1/me', async (request) => {
    const { id, userKey, displayName, role } = (request as RequestWithUser).currentUser!;
    return { id, userKey, displayName, role };
  });

  app.get('/v1/containers/tree', async (request) => ({ data: await visibleTree(prisma, (request as RequestWithUser).currentUser!) }));

  app.post('/v1/containers', async (request, reply) => {
    const user = (request as RequestWithUser).currentUser!;
    if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Only workspace admins can create containers.');
    const input = parseBody(createContainerSchema, request.body);
    if (input.type === 'space') {
      if (input.parentId) badRequest('A space must be directly under the workspace.');
    } else {
      if (!input.parentId) badRequest(`${input.type} requires a parent container.`);
      const parent = await prisma.container.findUnique({ where: { id: input.parentId! } });
      if (!parent || parent.archivedAt) throw new AppError(404, 'PARENT_NOT_FOUND', 'Parent container was not found.');
      if (parent.type !== parentType[input.type]) badRequest(`${input.type} must be inside a ${parentType[input.type]}.`);
    }
    const workspace = input.type === 'space' ? await prisma.container.findFirst({ where: { type: 'workspace', archivedAt: null } }) : null;
    if (input.type === 'space' && !workspace) throw new AppError(409, 'WORKSPACE_NOT_SEEDED', 'Workspace seed has not been applied.');
    const container = await prisma.container.create({ data: {
      name: input.name, type: input.type, parentId: input.type === 'space' ? workspace!.id : input.parentId!,
      position: input.position ?? 0, visibility: input.visibility ?? 'public',
    } });
    return reply.status(201).send({ data: container });
  });

  app.patch('/v1/containers/:id', async (request) => {
    const user = (request as RequestWithUser).currentUser!;
    if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Only workspace admins can edit containers.');
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ name: z.string().trim().min(1).max(120).optional(), position: z.number().int().min(0).optional(), visibility: z.enum(['public', 'private']).optional() }).parse(request.body);
    const existing = await prisma.container.findUnique({ where: { id: params.id } });
    if (!existing || existing.archivedAt) throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Container was not found.');
    return { data: await prisma.container.update({ where: { id: params.id }, data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.position !== undefined ? { position: body.position } : {}),
      ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
    } }) };
  });

  app.post('/v1/containers/:id/archive', async (request) => {
    const user = (request as RequestWithUser).currentUser!;
    if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Only workspace admins can archive containers.');
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const container = await prisma.container.findUnique({ where: { id } });
    if (!container || container.type === 'workspace') throw new AppError(404, 'CONTAINER_NOT_FOUND', 'Container was not found or cannot be archived.');
    await prisma.container.updateMany({ where: { id, archivedAt: null }, data: { archivedAt: new Date() } });
    return { data: { id, archived: true } };
  });

  app.get('/v1/lists/:id/resolved-statuses', async (request) => {
    const user = (request as RequestWithUser).currentUser!;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await requireContainerAccess(prisma, user, id);
    const { statuses } = await resolvedConfiguration(prisma, id);
    return { data: statuses };
  });

  app.get('/v1/lists/:id/resolved-fields', async (request) => {
    const user = (request as RequestWithUser).currentUser!;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await requireContainerAccess(prisma, user, id);
    const { fields } = await resolvedConfiguration(prisma, id);
    return { data: fields };
  });

  app.post('/v1/lists/:id/statuses', async (request, reply) => {
    const user = (request as RequestWithUser).currentUser!;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Only workspace admins can configure statuses.');
    const body = z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/),
      name: z.string().trim().min(1).max(80),
      category: z.enum(['not_started', 'active', 'done', 'closed']),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      position: z.number().int().min(0).optional(),
      disabled: z.boolean().optional(),
    }).parse(request.body);
    const owner = await prisma.container.findUnique({ where: { id } });
    if (!owner || !['space', 'folder', 'list'].includes(owner.type)) badRequest('Statuses can be configured on a space, folder, or list.');
    const duplicate = await prisma.statusDefinition.findUnique({ where: { ownerId_key: { ownerId: id, key: body.key } }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'STATUS_KEY_EXISTS', 'A status with this key already exists at this scope.');
    if (await statusKeyIsInUse(prisma, id, body.key)) throw new AppError(409, 'STATUS_IN_USE', 'Tasks use this status key. Move those tasks before overriding or disabling it.');
    for (const listId of await descendantListIds(prisma, id)) {
      const configuration = await resolvedConfiguration(prisma, listId);
      const ownerIndex = configuration.ancestors.findIndex((container) => container.id === id);
      if (ownerIndex < 0) continue;
      const nearerOwnerIds = configuration.ancestors.slice(ownerIndex + 1).map((container) => container.id);
      const nearerOverride = nearerOwnerIds.length ? await prisma.statusDefinition.findFirst({ where: { ownerId: { in: nearerOwnerIds }, key: body.key }, select: { id: true } }) : null;
      if (nearerOverride) continue;
      const statuses = configuration.statuses.filter((status) => status.key !== body.key);
      if (!body.disabled) statuses.push({ id: 'pending-status', key: body.key, name: body.name, category: body.category, color: body.color ?? '#64748b', position: body.position ?? 0, disabled: false });
      if (!hasRequiredStatusCategories(statuses)) throw new AppError(409, 'STATUS_CATEGORY_REQUIRED', 'Every affected list must retain at least one not-started, active, and done status.');
    }
    const status = await prisma.statusDefinition.create({ data: { ownerId: id, ...body, color: body.color ?? '#64748b', position: body.position ?? 0, disabled: body.disabled ?? false } });
    return reply.status(201).send({ data: status });
  });

  app.post('/v1/lists/:id/fields', async (request, reply) => {
    const user = (request as RequestWithUser).currentUser!;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    if (user.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Only workspace admins can configure fields.');
    const body = z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]{1,49}$/),
      name: z.string().trim().min(1).max(80),
      type: z.enum(['text', 'number', 'single_select', 'multi_select', 'date', 'checkbox']),
      required: z.boolean().optional(),
      options: z.array(z.object({ id: z.string(), label: z.string(), color: z.string().optional() })).optional(),
      position: z.number().int().min(0).optional(),
    }).parse(request.body);
    const owner = await prisma.container.findUnique({ where: { id } });
    if (!owner || !['space', 'folder', 'list'].includes(owner.type)) badRequest('Fields can be configured on a space, folder, or list.');
    if (['single_select', 'multi_select'].includes(body.type) && !body.options?.length) badRequest('Select fields require at least one option.');
    const duplicate = await prisma.customFieldDefinition.findUnique({ where: { ownerId_key: { ownerId: id, key: body.key } }, select: { id: true } });
    if (duplicate) throw new AppError(409, 'FIELD_KEY_EXISTS', 'A field with this key already exists at this scope.');
    if (await fieldKeyIsInUse(prisma, id, body.key, body.required ?? false)) throw new AppError(409, 'FIELD_IN_USE', 'Tasks depend on this field. Migrate or clear their values before overriding it or making it required.');
    const field = await prisma.customFieldDefinition.create({ data: { ownerId: id, ...body, options: body.options ?? [], required: body.required ?? false, position: body.position ?? 0 } });
    return reply.status(201).send({ data: field });
  });

  app.get('/v1/lists/:id/tasks', async (request) => {
    const user = (request as RequestWithUser).currentUser!;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await requireContainerAccess(prisma, user, id);
    const query = z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
      statusId: z.string().optional(),
    }).parse(request.query);
    const tasks = await prisma.task.findMany({
      where: { primaryListId: id, archivedAt: null, ...(query.statusId ? { statusId: query.statusId } : {}) },
      include: { status: true, assignees: { include: { user: { select: { id: true, userKey: true, displayName: true } } } } },
      orderBy: [{ position: 'asc' }, { id: 'asc' }], take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = tasks.length > query.limit;
    const page = tasks.slice(0, query.limit);
    return { data: page, pageInfo: { hasMore, nextCursor: hasMore ? page.at(-1)?.id ?? null : null } };
  });

  app.post('/v1/lists/:id/tasks', async (request, reply) => {
    const user = (request as RequestWithUser).currentUser!;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await requireCanEdit(prisma, user, id);
    const input = parseBody(createTaskSchema, request.body);
    const { statuses, fields } = await resolvedConfiguration(prisma, id);
    const customFields = input.customFields ?? {};
    const issues = validateTaskConfiguration(input.statusId, statuses, customFields, fields);
    if (issues.length) badRequest('Task does not match the resolved list configuration.', issues);
    if (input.assigneeIds?.length) {
      const found = await prisma.user.count({ where: { id: { in: input.assigneeIds } } });
      if (found !== new Set(input.assigneeIds).size) badRequest('One or more assignees do not exist.', [{ path: 'assigneeIds', code: 'UNKNOWN_USER', message: 'Every assignee must be a seeded user.' }]);
    }
    const lastTask = await prisma.task.findFirst({ where: { primaryListId: id, archivedAt: null }, orderBy: { position: 'desc' }, select: { position: true } });
    const task = await prisma.task.create({
      data: {
        primaryListId: id, title: input.title, statusId: input.statusId, description: input.description ?? null,
        priority: input.priority ?? 'none', dueDate: input.dueDate ? new Date(input.dueDate) : null,
        position: (lastTask?.position ?? -1) + 1, customValues: customFields as never,
        ...(input.assigneeIds?.length ? { assignees: { create: input.assigneeIds.map((userId) => ({ userId })) } } : {}),
      }, include: { status: true, assignees: { include: { user: { select: { id: true, userKey: true, displayName: true } } } } },
    });
    return reply.status(201).send({ data: task });
  });

  app.get('/v1/tasks/:id', async (request) => {
    const user = (request as RequestWithUser).currentUser!;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        status: true,
        primaryList: true,
        assignees: { include: { user: { select: { id: true, userKey: true, displayName: true } } } },
      },
    });
    if (!task || task.archivedAt) throw new AppError(404, 'TASK_NOT_FOUND', 'Task was not found.');
    await requireContainerAccess(prisma, user, task.primaryListId);
    const { fields } = await resolvedConfiguration(prisma, task.primaryListId);
    return { data: { ...task, customFieldDefinitions: fields } };
  });

  app.patch('/v1/tasks/:id', async (request) => {
    const user = (request as RequestWithUser).currentUser!;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing || existing.archivedAt) throw new AppError(404, 'TASK_NOT_FOUND', 'Task was not found.');
    await requireCanEdit(prisma, user, existing.primaryListId);
    const input = parseBody(updateTaskSchema, request.body);
    if (input.primaryListId && input.primaryListId !== existing.primaryListId) badRequest('Use the task move endpoint to change the primary list.');
    const { statuses, fields } = await resolvedConfiguration(prisma, existing.primaryListId);
    const nextStatusId = input.statusId ?? existing.statusId;
    const existingValues = existing.customValues && typeof existing.customValues === 'object' && !Array.isArray(existing.customValues) ? existing.customValues as Record<string, unknown> : {};
    const nextValues = input.customFields ? { ...existingValues, ...input.customFields } : existingValues;
    const issues = validateTaskConfiguration(nextStatusId, statuses, nextValues, fields);
    if (issues.length) badRequest('Task does not match the resolved list configuration.', issues);
    if (input.assigneeIds) {
      const found = await prisma.user.count({ where: { id: { in: input.assigneeIds } } });
      if (found !== new Set(input.assigneeIds).size) badRequest('One or more assignees do not exist.');
    }
    const task = await prisma.$transaction(async (tx) => {
      if (input.assigneeIds) await tx.taskAssignee.deleteMany({ where: { taskId: id } });
      return tx.task.update({ where: { id }, data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.statusId !== undefined ? { statusId: input.statusId } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate ? new Date(input.dueDate) : null } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.customFields !== undefined ? { customValues: nextValues as never } : {}),
        ...(input.assigneeIds ? { assignees: { create: input.assigneeIds.map((userId) => ({ userId })) } } : {}),
      }, include: {
        status: true,
        assignees: { include: { user: { select: { id: true, userKey: true, displayName: true } } } },
      } });
    });
    return { data: task };
  });

  app.post('/v1/tasks/:id/move', async (request) => {
    const user = (request as RequestWithUser).currentUser!;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = z.object({
      destinationListId: z.string(),
      statusId: z.string().optional(),
      customFields: z.record(z.string(), z.unknown()).optional(),
      position: z.number().int().min(0).optional(),
    }).parse(request.body);
    const task = await prisma.task.findUnique({ where: { id } });
    if (!task || task.archivedAt) throw new AppError(404, 'TASK_NOT_FOUND', 'Task was not found.');
    await requireCanEdit(prisma, user, task.primaryListId);
    await requireCanEdit(prisma, user, input.destinationListId);
    const { statuses, fields } = await resolvedConfiguration(prisma, input.destinationListId);
    const values = task.customValues && typeof task.customValues === 'object' && !Array.isArray(task.customValues) ? task.customValues as Record<string, unknown> : {};
    const nextValues = { ...values, ...(input.customFields ?? {}) };
    const issues = validateTaskConfiguration(input.statusId ?? task.statusId, statuses, nextValues, fields);
    if (issues.length) badRequest('Task cannot move until it matches the destination list configuration.', issues);
    const lastDestinationTask = await prisma.task.findFirst({ where: { primaryListId: input.destinationListId, archivedAt: null, id: { not: id } }, orderBy: { position: 'desc' }, select: { position: true } });
    const moved = await prisma.$transaction((tx) => tx.task.update({
      where: { id }, data: {
        primaryListId: input.destinationListId,
        statusId: input.statusId ?? task.statusId,
        position: input.position ?? (lastDestinationTask?.position ?? -1) + 1,
        customValues: nextValues as never,
      }, include: { status: true, primaryList: true },
    }));
    return { data: moved };
  });

  app.post('/v1/tasks/:id/archive', async (request) => {
    const user = (request as RequestWithUser).currentUser!;
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const task = await prisma.task.findUnique({ where: { id } });
    if (!task || task.archivedAt) throw new AppError(404, 'TASK_NOT_FOUND', 'Task was not found.');
    await requireCanEdit(prisma, user, task.primaryListId);
    await prisma.task.update({ where: { id }, data: { archivedAt: new Date() } });
    return { data: { id, archived: true } };
  });

  return app;
}
