import { describe, expect, it } from 'vitest';
import { hasRequiredStatusCategories, resolveFields, resolveStatuses, type Owned, type StatusDefinition } from './configuration.js';

const status = (id: string, key: string, name: string, position: number, disabled = false): Owned<StatusDefinition> => ({
  ownerId: id,
  definition: { id, key, name, category: 'active', color: '#000', position, disabled },
});

describe('resolved configuration', () => {
  it('applies the nearest definition for a stable key and adds child keys', () => {
    const result = resolveStatuses([
      status('workspace', 'todo', 'To do', 0),
      status('folder', 'todo', 'Ready', 1),
      status('list', 'review', 'Review', 2),
    ]);
    expect(result.map(({ key, name }) => [key, name])).toEqual([
      ['todo', 'Ready'],
      ['review', 'Review'],
    ]);
  });

  it('hides explicitly disabled inherited statuses', () => {
    const result = resolveStatuses([
      status('workspace', 'todo', 'To do', 0),
      status('list', 'todo', 'To do', 0, true),
    ]);
    expect(result).toEqual([]);
  });

  it('requires every resolved set to retain not-started, active, and done categories', () => {
    const complete = [
      { ...status('workspace', 'todo', 'To do', 0).definition, category: 'not_started' as const },
      status('workspace', 'doing', 'Doing', 1).definition,
      { ...status('workspace', 'done', 'Done', 2).definition, category: 'done' as const },
    ];
    expect(hasRequiredStatusCategories(complete)).toBe(true);
    expect(hasRequiredStatusCategories(complete.slice(0, 2))).toBe(false);
  });

  it('resolves inherited custom fields by key with nearest owner winning', () => {
    const result = resolveFields([
      { ownerId: 'space', definition: { id: 'a', key: 'estimate', name: 'Estimate', type: 'number', required: false, options: [], position: 0, archivedAt: null } },
      { ownerId: 'list', definition: { id: 'b', key: 'estimate', name: 'Points', type: 'number', required: true, options: [], position: 1, archivedAt: null } },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Points');
    expect(result[0]?.required).toBe(true);
  });
});
