import { Role } from '../../generated/prisma/client.js';
import { forbidden } from '../errors/api-error.js';
import type { AuthenticatedUser } from './authenticated-user.js';

/**
 * Resource-level check that role guards cannot express: "is this record yours?".
 * Customers and workers may only touch their own data; admins may touch any.
 * Call it in every handler that takes an id, e.g. before returning a booking.
 */
export function assertOwnerOrAdmin(user: AuthenticatedUser, ownerUserId: string): void {
  if (user.role === Role.ADMIN) return;
  if (user.id !== ownerUserId) {
    throw forbidden('FORBIDDEN_RESOURCE', 'You do not have access to this resource');
  }
}
