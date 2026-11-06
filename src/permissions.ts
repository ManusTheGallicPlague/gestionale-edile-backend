/**
 * The permission catalog. Roles are configured per company, but only these values exist:
 * a new module adds its lines here and in the contract (components.schemas.Permission).
 */
export const PERMISSIONS = [
  'clients.view',
  'clients.create',
  'clients.update',
  'clients.delete',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const known = new Set<string>(PERMISSIONS)

export function isPermission(value: string): value is Permission {
  return known.has(value)
}
