import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const existingWorkspace = await prisma.container.findFirst({ where: { type: 'workspace' } });
  if (existingWorkspace) {
    console.log(`Flowboard workspace ${existingWorkspace.id} already exists; seed data was left unchanged.`);
    return;
  }

  const [alice, bob, carol] = await Promise.all([
    prisma.user.create({ data: { userKey: 'alice', displayName: 'Alice Chen', role: 'admin' } }),
    prisma.user.create({ data: { userKey: 'bob', displayName: 'Bob Rivera', role: 'member' } }),
    prisma.user.create({ data: { userKey: 'carol', displayName: 'Carol Okafor', role: 'member' } }),
  ]);

  const workspace = await prisma.container.create({ data: { type: 'workspace', name: 'Flowboard Team', visibility: 'public' } });
  const engineering = await prisma.container.create({ data: { type: 'space', name: 'Engineering', parentId: workspace.id } });
  const product = await prisma.container.create({ data: { type: 'space', name: 'Product', parentId: workspace.id, position: 1 } });
  const q2 = await prisma.container.create({ data: { type: 'folder', name: 'Q2 Launch', parentId: engineering.id } });
  const platform = await prisma.container.create({ data: { type: 'folder', name: 'Platform', parentId: engineering.id, position: 1 } });
  const backlog = await prisma.container.create({ data: { type: 'list', name: 'Backlog', parentId: q2.id } });
  const delivery = await prisma.container.create({ data: { type: 'list', name: 'Delivery', parentId: q2.id, position: 1 } });
  const roadmap = await prisma.container.create({ data: { type: 'list', name: 'Roadmap', parentId: product.id, position: 2, visibility: 'private' } });
  await prisma.container.create({ data: { type: 'list', name: 'Infrastructure', parentId: platform.id, position: 1 } });

  await prisma.containerGrant.createMany({ data: [
    { containerId: engineering.id, userId: bob.id, mode: 'allow' },
    { containerId: q2.id, userId: bob.id, mode: 'allow' },
    { containerId: backlog.id, userId: bob.id, mode: 'allow' },
    { containerId: delivery.id, userId: bob.id, mode: 'allow' },
    { containerId: product.id, userId: carol.id, mode: 'allow' },
    { containerId: roadmap.id, userId: carol.id, mode: 'allow' },
    { containerId: engineering.id, userId: carol.id, mode: 'deny' },
  ] });

  const defaultStatuses = [
    { key: 'todo', name: 'To do', category: 'not_started' as const, color: '#8492a6', position: 0 },
    { key: 'in_progress', name: 'In progress', category: 'active' as const, color: '#5b8def', position: 1 },
    { key: 'done', name: 'Done', category: 'done' as const, color: '#26a269', position: 2 },
  ];
  await prisma.statusDefinition.createMany({ data: defaultStatuses.map((status) => ({ ownerId: workspace.id, ...status })) });
  await prisma.statusDefinition.createMany({ data: [
    { ownerId: delivery.id, key: 'in_progress', name: 'Building', category: 'active', color: '#7c5ce7', position: 1 },
    { ownerId: delivery.id, key: 'review', name: 'Review', category: 'active', color: '#d9822b', position: 2 },
    { ownerId: delivery.id, key: 'done', name: 'Shipped', category: 'done', color: '#26a269', position: 3 },
  ] });
  await prisma.statusDefinition.createMany({ data: [
    { ownerId: backlog.id, key: 'in_progress', name: 'Doing', category: 'active', color: '#1e88a8', position: 1 },
  ] });

  await prisma.customFieldDefinition.createMany({ data: [
    { ownerId: engineering.id, key: 'estimate', name: 'Estimate', type: 'number', required: true, position: 0, options: [] },
    { ownerId: q2.id, key: 'component', name: 'Component', type: 'single_select', required: false, position: 1, options: [{ id: 'api', label: 'API', color: '#5b8def' }, { id: 'web', label: 'Web', color: '#7c5ce7' }, { id: 'data', label: 'Data', color: '#26a269' }] },
    { ownerId: backlog.id, key: 'customer_impact', name: 'Customer impact', type: 'checkbox', required: false, position: 2, options: [] },
  ] });

  const listConfigs = [
    { list: backlog, statuses: ['todo', 'in_progress', 'done'] },
    { list: delivery, statuses: ['todo', 'in_progress', 'review', 'done'] },
    { list: roadmap, statuses: ['todo', 'in_progress', 'done'] },
  ];
  let globalPosition = 0;
  for (const { list, statuses } of listConfigs) {
    const [workspaceDefinitions, localDefinitions] = await Promise.all([
      prisma.statusDefinition.findMany({ where: { ownerId: workspace.id }, orderBy: { position: 'asc' } }),
      prisma.statusDefinition.findMany({ where: { ownerId: list.id }, orderBy: { position: 'asc' } }),
    ]);
    const byKey = new Map(workspaceDefinitions.map((definition) => [definition.key, definition]));
    for (const definition of localDefinitions) byKey.set(definition.key, definition);
    const referenceDate = new Date('2026-10-25T12:00:00.000Z');
    for (let index = 0; index < 24; index += 1) {
      const statusKey = statuses[index % statuses.length]!;
      const status = byKey.get(statusKey)!;
      const titleParts = ['Review API contract', 'Polish board interactions', 'Improve onboarding flow', 'Add audit events', 'Tune database indexes', 'Prepare release checklist'];
      await prisma.task.create({
        data: {
          primaryListId: list.id,
          title: `${titleParts[index % titleParts.length]} ${String(index + 1).padStart(2, '0')}`,
          description: index % 3 === 0 ? 'Coordinate implementation and verify behavior with the team.' : null,
          statusId: status.id,
          priority: (['urgent', 'high', 'normal', 'low', 'none'] as const)[index % 5]!,
          dueDate: index % 4 === 0 ? new Date(referenceDate.getTime() + (index - 8) * 86_400_000) : null,
          customValues: {
            estimate: (index % 8) + 1,
            component: (['api', 'web', 'data'] as const)[index % 3]!,
            customer_impact: index % 2 === 0,
          },
          position: index,
          assignees: { create: [{ userId: index % 2 === 0 ? bob.id : carol.id }] },
        },
      });
      globalPosition += 1;
    }
  }
  console.log(`Seeded Flowboard workspace ${workspace.id} with ${globalPosition} tasks and users ${alice.userKey}, ${bob.userKey}, ${carol.userKey}.`);
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
