export interface AccessGrant {
  userId: string
  mode: 'allow' | 'deny'
}

export interface AccessibleContainer {
  visibility: 'public' | 'private'
  archivedAt: Date | null
  grants: readonly AccessGrant[]
}

export function canAccessContainerChain(
  role: 'admin' | 'member',
  userId: string,
  ancestorFirst: readonly AccessibleContainer[],
) {
  if (ancestorFirst.some((container) => container.archivedAt !== null)) return false
  if (role === 'admin') return true

  return ancestorFirst.every((container) => {
    const grant = container.grants.find((item) => item.userId === userId)
    return grant?.mode !== 'deny' && (container.visibility !== 'private' || grant?.mode === 'allow')
  })
}
