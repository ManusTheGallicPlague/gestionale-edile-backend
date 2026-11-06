/**
 * The permission catalog. Roles are configured per company, but only these values exist:
 * a new module adds its lines here and in the contract (components.schemas.Permission).
 */
export const PERMISSIONS = [
  'clients.view',
  'clients.create',
  'clients.update',
  'clients.delete',
  'suppliers.view',
  'suppliers.create',
  'suppliers.update',
  'suppliers.delete',
  'deadlines.view',
  'deadlines.create',
  'deadlines.update',
  'deadlines.delete',
] as const

export type Permission = (typeof PERMISSIONS)[number]

const known = new Set<string>(PERMISSIONS)

export function isPermission(value: string): value is Permission {
  return known.has(value)
}
