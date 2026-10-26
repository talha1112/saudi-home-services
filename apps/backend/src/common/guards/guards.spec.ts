import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { assertOwnerOrAdmin } from '../auth/ownership.js';
import { Role, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { ApprovedWorkerGuard } from './approved-worker.guard.js';
import { RolesGuard } from './roles.guard.js';

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    id: 'u-1',
    sessionId: 's-1',
    role: Role.CUSTOMER,
    roles: [Role.CUSTOMER],
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
    ...overrides,
  };
}

function context(u?: AuthenticatedUser): ExecutionContext {
  return {
    getHandler: () => 'handler',
    getClass: () => 'class',
    switchToHttp: () => ({ getRequest: () => ({ user: u }) }),
  } as unknown as ExecutionContext;
}

function reflectorWith(meta: Record<string, unknown>): Reflector {
  return { getAllAndOverride: (key: string) => meta[key] } as unknown as Reflector;
}

describe('RolesGuard', () => {
  it('allows any signed-in role when the route declares no roles', () => {
    expect(new RolesGuard(reflectorWith({})).canActivate(context(user()))).toBe(true);
  });

  it('allows a listed role', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [Role.ADMIN, Role.WORKER] }));
    expect(guard.canActivate(context(user({ role: Role.WORKER })))).toBe(true);
  });

  it.each([Role.CUSTOMER, Role.WORKER])('blocks %s from an admin-only route', (role) => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [Role.ADMIN] }));
    expect(() => guard.canActivate(context(user({ role })))).toThrow('cannot perform');
  });

  it('judges the session role, not every role the person holds', () => {
    // Holds WORKER too, but this session is the customer app.
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [Role.WORKER] }));
    expect(() => guard.canActivate(context(user({ role: Role.CUSTOMER, roles: [Role.CUSTOMER, Role.WORKER] })))).toThrow();
  });

  it('skips public routes', () => {
    const guard = new RolesGuard(reflectorWith({ [IS_PUBLIC_KEY]: true, [ROLES_KEY]: [Role.ADMIN] }));
    expect(guard.canActivate(context())).toBe(true);
  });

  it('denies when a role is required but nobody is authenticated', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [Role.ADMIN] }));
    expect(() => guard.canActivate(context())).toThrow();
  });
});

describe('ApprovedWorkerGuard', () => {
  const guard = new ApprovedWorkerGuard();
  const worker = (status?: WorkerVerificationStatus) =>
    context(user({ role: Role.WORKER, roles: [Role.WORKER], workerVerificationStatus: status }));

  it('allows an approved worker', () => {
    expect(guard.canActivate(worker(WorkerVerificationStatus.APPROVED))).toBe(true);
  });

  it.each([
    WorkerVerificationStatus.NOT_SUBMITTED,
    WorkerVerificationStatus.SUBMITTED,
    WorkerVerificationStatus.UNDER_REVIEW,
    WorkerVerificationStatus.INFO_REQUIRED,
    WorkerVerificationStatus.REJECTED,
  ])('blocks a worker whose verification is %s', (status) => {
    expect(() => guard.canActivate(worker(status))).toThrow('not been approved');
  });

  it('blocks a worker with no profile status and non-workers', () => {
    expect(() => guard.canActivate(worker(undefined))).toThrow();
    expect(() => guard.canActivate(context(user()))).toThrow();
    expect(() => guard.canActivate(context(user({ role: Role.ADMIN })))).toThrow();
  });
});

describe('assertOwnerOrAdmin', () => {
  it('lets owners and admins through, blocks everyone else', () => {
    expect(() => assertOwnerOrAdmin(user({ id: 'a' }), 'a')).not.toThrow();
    expect(() => assertOwnerOrAdmin(user({ id: 'admin', role: Role.ADMIN }), 'a')).not.toThrow();
    expect(() => assertOwnerOrAdmin(user({ id: 'b' }), 'a')).toThrow('do not have access');
  });
});
