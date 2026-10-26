import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser, RequestWithUser } from '../auth/authenticated-user.js';

/** Injects the authenticated caller. Only meaningful on non-public routes. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const user = ctx.switchToHttp().getRequest<RequestWithUser>().user;
  if (!user) throw new Error('CurrentUser used on a route without authentication');
  return user;
});
