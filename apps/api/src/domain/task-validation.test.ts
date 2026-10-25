import { describe, expect, it } from 'vitest';
import { validateTaskConfiguration } from './task-validation.js';
import type { FieldDefinition, StatusDefinition } from './configuration.js';

const statuses: StatusDefinition[] = [{ id: 'todo', key: 'todo', name: 'To do', category: 'not_started', color: '#fff', position: 0, disabled: false }];
const fields: FieldDefinition[] = [
  { id: 'estimate', key: 'estimate', name: 'Estimate', type: 'number', required: true, options: [], position: 0, archivedAt: null },
  { id: 'kind', key: 'kind', name: 'Kind', type: 'single_select', required: false, options: [{ id: 'bug', label: 'Bug' }], position: 1, archivedAt: null },
];

describe('validateTaskConfiguration', () => {
  it('rejects unknown statuses, invalid types, options, and missing required values', () => {
    expect(validateTaskConfiguration('missing', statuses, { estimate: 'large', kind: 'feature' }, fields).map((issue) => issue.path)).toEqual([
      'statusId', 'customFields.estimate', 'customFields.kind',
    ]);
  });

  it('accepts valid resolved status and field values', () => {
    expect(validateTaskConfiguration('todo', statuses, { estimate: 3, kind: 'bug' }, fields)).toEqual([]);
  });
});
