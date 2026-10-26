import { SetMetadata } from '@nestjs/common';
import type { Role } from '../../generated/prisma/client.js';

export const ROLES_KEY = 'auth:roles';

/** Restricts a route to sessions acting as one of the given roles. Without it, any signed-in role may call the route. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
