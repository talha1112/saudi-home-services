import type { AuthConfig } from '../config/app.config.js';
import { AdminAuthService } from '../modules/auth/admin/admin-auth.service.js';
import { AdminBootstrapService } from '../modules/auth/admin/admin-bootstrap.service.js';
import { NoMfaPolicy } from '../modules/auth/admin/admin-mfa.policy.js';
import { AuditService } from '../modules/auth/audit.service.js';
import { AuthService } from '../modules/auth/auth.service.js';
import { OtpService } from '../modules/auth/otp/otp.service.js';
import { PasswordService } from '../modules/auth/password.service.js';
import { SessionsService } from '../modules/auth/sessions.service.js';
import { TokenService } from '../modules/auth/tokens/token.service.js';
import { InMemoryPrisma } from './in-memory-prisma.js';
import { MemoryKeyValueStore } from './memory-key-value.store.js';
import { CapturingSmsProvider, testConfigService } from './test-support.js';

/** Wires the real auth services to in-memory stores, without Nest's container. */
export function buildAuthServices(authOverrides: Partial<AuthConfig> = {}) {
  const config = testConfigService(authOverrides);
  const db = new InMemoryPrisma();
  const prisma = db.asPrisma();
  const store = new MemoryKeyValueStore();
  const sms = new CapturingSmsProvider();
  const tokens = new TokenService(config);
  const audit = new AuditService(prisma);
  const sessions = new SessionsService(config, prisma, tokens, audit);
  const otp = new OtpService(config, store, sms);
  const passwords = new PasswordService();
  const auth = new AuthService(config, prisma, otp, sessions, audit);
  const adminAuth = new AdminAuthService(prisma, store, passwords, sessions, new NoMfaPolicy(), audit, auth);
  const bootstrap = new AdminBootstrapService(prisma, passwords, sessions, audit);
  return { config, db, prisma, store, sms, tokens, audit, sessions, otp, passwords, auth, adminAuth, bootstrap };
}
