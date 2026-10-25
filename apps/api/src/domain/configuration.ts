export type StatusCategory = 'not_started' | 'active' | 'done' | 'closed';

export interface StatusDefinition {
  id: string;
  key: string;
  name: string;
  category: StatusCategory;
  color: string;
  position: number;
  disabled: boolean;
}

export interface FieldDefinition {
  id: string;
  key: string;
  name: string;
  type: 'text' | 'number' | 'single_select' | 'multi_select' | 'date' | 'checkbox';
  required: boolean;
  options: Array<{ id: string; label: string; color?: string }>;
  position: number;
  archivedAt: Date | null;
}

export interface Owned<T> {
  ownerId: string;
  definition: T;
}

export function resolveByKey<T extends { key: string }>(
  ancestorFirst: readonly Owned<T>[],
): T[] {
  const resolved = new Map<string, T>();
  for (const { definition } of ancestorFirst) resolved.set(definition.key, definition);
  return [...resolved.values()];
}

export function resolveStatuses(ancestorFirst: readonly Owned<StatusDefinition>[]): StatusDefinition[] {
  return resolveByKey(ancestorFirst)
    .filter((status) => !status.disabled)
    .sort((left, right) => left.position - right.position || left.key.localeCompare(right.key));
}

export function resolveFields(ancestorFirst: readonly Owned<FieldDefinition>[]): FieldDefinition[] {
  return resolveByKey(ancestorFirst)
    .filter((field) => field.archivedAt === null)
    .sort((left, right) => left.position - right.position || left.key.localeCompare(right.key));
}
