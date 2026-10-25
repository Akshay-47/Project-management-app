import type { FieldDefinition, StatusDefinition } from './configuration.js';

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export function validateTaskConfiguration(
  statusId: string,
  statuses: readonly StatusDefinition[],
  values: Readonly<Record<string, unknown>>,
  fields: readonly FieldDefinition[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!statuses.some((status) => status.id === statusId)) {
    issues.push({ path: 'statusId', code: 'STATUS_NOT_RESOLVED', message: 'Status is not available for this list.' });
  }

  const fieldKeys = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(values)) {
    if (!fieldKeys.has(key)) issues.push({ path: `customFields.${key}`, code: 'FIELD_NOT_RESOLVED', message: 'Field is not available for this list.' });
  }

  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === null || value === '') {
      if (field.required) issues.push({ path: `customFields.${field.key}`, code: 'FIELD_REQUIRED', message: `${field.name} is required.` });
      continue;
    }

    const typeIsValid = (() => {
      switch (field.type) {
        case 'text': return typeof value === 'string';
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        case 'checkbox': return typeof value === 'boolean';
        case 'date': return typeof value === 'string' && !Number.isNaN(Date.parse(value));
        case 'single_select': return typeof value === 'string' && field.options.some((option) => option.id === value);
        case 'multi_select': return Array.isArray(value) && value.every((item) => typeof item === 'string' && field.options.some((option) => option.id === item));
      }
    })();
    if (!typeIsValid) issues.push({ path: `customFields.${field.key}`, code: 'INVALID_FIELD_VALUE', message: `Value does not match ${field.type} field ${field.name}.` });
  }
  return issues;
}
