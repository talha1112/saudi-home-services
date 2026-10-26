import { Role, UserStatus } from '../../../generated/prisma/client.js';
import { buildAuthServices } from '../../../testing/harness.js';
import { AdminSetupError } from './admin-bootstrap.service.js';

const EMAIL = 'owner@example.com';
const PASSWORD = 'initial-Passw0rd-xyz';

async function setup() {
  const s = buildAuthServices();
  await s.bootstrap.createInitialAdmin({ email: EMAIL, password: PASSWORD });
  return s;
}

describe('AdminBootstrapService', () => {
  it('creates the first admin with a hashed password and a forced password change', async () => {
    const { db } = await setup();
    const admin = db.users[0];
    expect(admin.email).toBe(EMAIL);
    expect(admin.phone).toBeNull();
    expect(admin.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(admin)).not.toContain(PASSWORD);
    expect(admin.mustChangePassword).toBe(true);
    expect(db.userRoles).toEqual([expect.objectContaining({ userId: admin.id, role: Role.ADMIN })]);
    expect(db.auditLogs.map((a) => a.action)).toContain('admin.bootstrapped');
  });

  it('refuses to create a second administrator', async () => {
    const { bootstrap } = await setup();
    await expect(bootstrap.createInitialAdmin({ email: 'other@example.com', password: PASSWORD })).rejects.toBeInstanceOf(
      AdminSetupError,
    );
  });

  it('rejects an invalid email or weak password', async () => {
    const { bootstrap } = buildAuthServices();
    await expect(bootstrap.createInitialAdmin({ email: 'nope', password: PASSWORD })).rejects.toThrow('email');
    await expect(bootstrap.createInitialAdmin({ email: EMAIL, password: 'short' })).rejects.toThrow('12');
  });

  it('reset-password replaces the password, forces a change and signs the admin out everywhere', async () => {
    const { bootstrap, adminAuth, sessions, db } = await setup();
    const session = await adminAuth.login({ email: EMAIL, password: PASSWORD }, {});
    await bootstrap.resetPassword(EMAIL, 'recovered-Passw0rd-abc');

    const sid = db.refreshTokens[0].familyId as string;
    expect(await sessions.isActive(sid, session.user.id)).toBe(false);
    await expect(adminAuth.login({ email: EMAIL, password: PASSWORD }, {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const again = await adminAuth.login({ email: EMAIL, password: 'recovered-Passw0rd-abc' }, {});
    expect(again.user.mustChangePassword).toBe(true);
  });

  it('reset-password fails for unknown or non-admin accounts', async () => {
    const { bootstrap, prisma } = await setup();
    await prisma.user.create({ data: { email: 'cust@example.com', roles: { create: [{ role: Role.CUSTOMER }] } } });
    await expect(bootstrap.resetPassword('nobody@example.com', PASSWORD)).rejects.toBeInstanceOf(AdminSetupError);
    await expect(bootstrap.resetPassword('cust@example.com', PASSWORD)).rejects.toBeInstanceOf(AdminSetupError);
  });
});

describe('AdminAuthService', () => {
  it('signs an admin in and never exposes the hash', async () => {
    const { adminAuth } = await setup();
    const session = await adminAuth.login({ email: EMAIL, password: PASSWORD }, { ip: '1.1.1.1' });
    expect(session.user.activeRole).toBe(Role.ADMIN);
    expect(session.user.roles).toEqual([Role.ADMIN]);
    const json = JSON.stringify(session);
    expect(json).not.toMatch(/argon2|passwordHash|tokenHash/);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const { adminAuth } = await setup();
    const wrong = await adminAuth.login({ email: EMAIL, password: 'wrong-password-1' }, {}).catch((e) => e);
    const unknown = await adminAuth.login({ email: 'ghost@example.com', password: 'wrong-password-1' }, {}).catch((e) => e);
    expect(wrong.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.getResponse().message).toBe(unknown.getResponse().message);
  });

  it('does not let a customer account sign in as admin even with a password', async () => {
    const { adminAuth, prisma, passwords } = await setup();
    await prisma.user.create({
      data: {
        email: 'cust@example.com',
        passwordHash: await passwords.hash('customer-Passw0rd-1'),
        status: UserStatus.ACTIVE,
        roles: { create: [{ role: Role.CUSTOMER }] },
      },
    });
    await expect(adminAuth.login({ email: 'cust@example.com', password: 'customer-Passw0rd-1' }, {})).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
  });

  it('locks out after repeated failures, even for the right password', async () => {
    const { adminAuth } = await setup();
    for (let i = 0; i < 5; i++) {
      await expect(adminAuth.login({ email: EMAIL, password: 'bad-password-123' }, { ip: '9.9.9.9' })).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
    }
    const locked = await adminAuth.login({ email: EMAIL, password: PASSWORD }, { ip: '9.9.9.9' }).catch((e) => e);
    expect(locked.getStatus()).toBe(429);
    expect(locked.code).toBe('LOGIN_LOCKED');
  });

  it('refuses a suspended admin', async () => {
    const { adminAuth, prisma, db } = await setup();
    await prisma.user.update({ where: { id: db.users[0].id }, data: { status: UserStatus.SUSPENDED } });
    await expect(adminAuth.login({ email: EMAIL, password: PASSWORD }, {})).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });
  });

  it('changes the password, clears the forced change and revokes every old session', async () => {
    const { adminAuth, sessions, db, auth } = await setup();
    const first = await adminAuth.login({ email: EMAIL, password: PASSWORD }, {});
    const current = {
      id: first.user.id,
      sessionId: db.refreshTokens[0].familyId as string,
      role: Role.ADMIN,
      roles: [Role.ADMIN],
      status: UserStatus.ACTIVE,
      mustChangePassword: true,
    };

    const next = await adminAuth.changePassword(current, { currentPassword: PASSWORD, newPassword: 'brand-New-Passw0rd-9' }, {});
    expect(next.user.mustChangePassword).toBe(false);
    expect(await sessions.isActive(current.sessionId, current.id)).toBe(false);
    await expect(auth.refresh(first.refreshToken, {})).rejects.toBeDefined();
    await expect(adminAuth.login({ email: EMAIL, password: PASSWORD }, {})).rejects.toBeDefined();
    await expect(adminAuth.login({ email: EMAIL, password: 'brand-New-Passw0rd-9' }, {})).resolves.toBeDefined();
  });

  it('change-password checks the current password and the new password policy', async () => {
    const { adminAuth, db } = await setup();
    const session = await adminAuth.login({ email: EMAIL, password: PASSWORD }, {});
    const current = {
      id: session.user.id,
      sessionId: db.refreshTokens[0].familyId as string,
      role: Role.ADMIN,
      roles: [Role.ADMIN],
      status: UserStatus.ACTIVE,
      mustChangePassword: true,
    };
    await expect(adminAuth.changePassword(current, { currentPassword: 'wrong-pass-123', newPassword: 'brand-New-Passw0rd-9' }, {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(adminAuth.changePassword(current, { currentPassword: PASSWORD, newPassword: 'short' }, {})).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    await expect(adminAuth.changePassword(current, { currentPassword: PASSWORD, newPassword: PASSWORD }, {})).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
  });
});
