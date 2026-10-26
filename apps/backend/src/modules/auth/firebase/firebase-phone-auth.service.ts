import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, forbidden, unauthorized, unavailable } from '../../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig } from '../../../config/app.config.js';
import { KeyValueStore } from '../../../database/key-value.store.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { type Prisma, Role, UserStatus, WorkerVerificationStatus } from '../../../generated/prisma/client.js';
import { AuditService, redactAuditMetadata } from '../audit.service.js';
import type { ClientMeta } from '../auth.types.js';
import { AuthService } from '../auth.service.js';
import type { AuthSessionDto, FirebasePhoneSignInDto } from '../dto/auth.dto.js';
import { normalizePhone } from '../phone.js';
import { SessionsService } from '../sessions.service.js';
import { toAuthUser } from '../user-view.js';
import { FirebaseIdentityVerifier, FirebaseVerificationError, type VerifiedFirebaseIdentity } from './firebase-identity-verifier.js';

/** Audit action that records which Firebase identity an account belongs to. Written in the same transaction that creates or adopts the account. */
export const FIREBASE_BOUND_ACTION = 'auth.firebase_identity_bound';

const WITH_ACCOUNT = {
  roles: true,
  workerProfile: { select: { id: true, verificationStatus: true } },
  customerProfile: { select: { id: true } },
} as const;

type Account = Prisma.UserGetPayload<{ include: typeof WITH_ACCOUNT }>;
type Tx = Prisma.TransactionClient;
type Outcome = 'create' | 'sign_in' | 'adopt' | 'change';

const CLOCK_SKEW_MS = 60_000;
const SAFE_UID = /^[A-Za-z0-9_-]{1,128}$/;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Sign-in with a Firebase ID token obtained through Firebase Phone Authentication.
 *
 * The phone number, the Firebase user id and the time of the SMS check come ONLY from the verified token. The request body carries the
 * token and which app is asking; it can carry no phone number, user id or role (the global validation pipe rejects extra fields).
 *
 * Account ownership. A phone number proves who holds the number NOW. It does not prove the holder is the person the account belongs to
 * (numbers are recycled), and this deployment stores no Firebase user id in a column. So the rules are conservative:
 *  - an unknown number creates a new account and records its Firebase user id (an audit entry written in the same transaction);
 *  - a known number signs in only if the account's recorded Firebase identity is the SAME one;
 *  - a known account with no recorded Firebase identity, or a DIFFERENT one, is refused (409) and left untouched, because ownership is ambiguous;
 *  - an administrator account, or a number that was never verified, is never reachable this way;
 *  - FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION=true (demo only) accepts the ambiguity and records the change in the audit trail.
 * Everything else (suspended / deactivated accounts, worker approval, role checks, refresh-token rotation) is the existing logic, unchanged.
 */
@Injectable()
export class FirebasePhoneAuthService {
  private readonly logger = new Logger(FirebasePhoneAuthService.name);
  private readonly region: string;
  private readonly maxAuthAgeMs: number;
  private readonly allowAdoption: boolean;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly verifier: FirebaseIdentityVerifier,
    private readonly store: KeyValueStore,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {
    const app = config.getOrThrow<AppConfig>(APP_CONFIG);
    this.region = app.auth.defaultPhoneRegion;
    this.maxAuthAgeMs = app.firebase.auth.maxAuthAgeSeconds * 1000;
    this.allowAdoption = app.firebase.auth.allowAccountAdoption;
    if (app.firebase.auth.enabled && this.allowAdoption && app.isProduction) {
      this.logger.warn('FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION is on: an existing account can be taken over by phone match. Use only with a demo Firebase project and synthetic data');
    }
  }

  async signIn(dto: FirebasePhoneSignInDto, meta: ClientMeta): Promise<AuthSessionDto> {
    if (!this.verifier.enabled) throw unavailable('FIREBASE_AUTH_NOT_CONFIGURED', 'Phone sign-in is not available right now');
    const role = dto.app === 'worker' ? Role.WORKER : Role.CUSTOMER;

    const identity = await this.verify(dto.idToken);
    if (identity.signInProvider !== 'phone') throw unauthorized('FIREBASE_PROVIDER_NOT_ALLOWED', 'Sign in with your phone number');
    // The Firebase user id becomes a stored identity binding, so it must survive audit redaction unchanged. Firebase generates phone users'
    // ids as plain alphanumerics; anything outside this safe set is not a token we accept.
    if (!SAFE_UID.test(identity.uid)) throw unauthorized('FIREBASE_TOKEN_INVALID', 'The sign-in could not be verified');
    const phone = this.certifiedPhone(identity);
    this.assertFresh(identity);

    // Read-only decision first, so a refused sign-in changes nothing; the token is then consumed atomically (exactly one request wins).
    let existing = await this.findByPhone(phone);
    let outcome = await this.decide(existing, identity, meta);
    await this.consumeToken(dto.idToken, identity);

    let isNewUser = false;
    let user: Account;
    for (let attempt = 0; ; attempt++) {
      try {
        ({ user, isNewUser } = await this.apply(outcome, existing, phone, role, identity, meta));
        break;
      } catch (err) {
        // Two first sign-ins for one number raced and the other one created the account: decide again against the winner.
        if ((err as { code?: string }).code !== 'P2002' || attempt > 0) throw err;
        existing = await this.findByPhone(phone);
        outcome = await this.decide(existing, identity, meta);
      }
    }

    const tokens = await this.sessions.create(user.id, role, meta);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({
      action: 'auth.sign_in',
      actorUserId: user.id,
      entityType: 'user',
      entityId: user.id,
      metadata: { method: 'firebase_phone', role, newUser: isNewUser, firebaseUid: identity.uid },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ...this.auth.toSession(tokens, toAuthUser(user, role)), isNewUser };
  }

  // ---------------------------------------------------------------- token checks

  private async verify(idToken: string): Promise<VerifiedFirebaseIdentity> {
    try {
      return await this.verifier.verify(idToken);
    } catch (err) {
      const kind = err instanceof FirebaseVerificationError ? err.kind : 'UNAVAILABLE';
      switch (kind) {
        case 'EXPIRED':
          throw unauthorized('FIREBASE_TOKEN_EXPIRED', 'The sign-in has expired. Verify your phone number again');
        case 'UNAVAILABLE':
          throw unavailable('FIREBASE_UNAVAILABLE', 'Phone sign-in is temporarily unavailable. Please try again shortly');
        case 'NOT_CONFIGURED':
          throw unavailable('FIREBASE_AUTH_NOT_CONFIGURED', 'Phone sign-in is not available right now');
        default: // INVALID, REVOKED, USER_DISABLED: one answer, so nothing is revealed about why
          throw unauthorized('FIREBASE_TOKEN_INVALID', 'The sign-in could not be verified');
      }
    }
  }

  /** The number Firebase certified, as E.164, or a refusal. International numbers are accepted; the claim must already be in canonical form. */
  private certifiedPhone(identity: VerifiedFirebaseIdentity): string {
    const claim = identity.phoneNumber;
    if (!claim) throw unauthorized('FIREBASE_PHONE_MISSING', 'The sign-in does not include a verified phone number');
    const normalized = normalizePhone(claim, this.region);
    if (!normalized || normalized !== claim) throw unauthorized('FIREBASE_PHONE_INVALID', 'The verified phone number is not valid');
    return normalized;
  }

  /** A token can be minted for up to an hour after the SMS check. Only a recent real sign-in is exchanged. */
  private assertFresh(identity: VerifiedFirebaseIdentity): void {
    const age = Date.now() - identity.authTime.getTime();
    if (age > this.maxAuthAgeMs) throw unauthorized('FIREBASE_TOKEN_STALE', 'Please verify your phone number again');
    if (age < -CLOCK_SKEW_MS) throw unauthorized('FIREBASE_TOKEN_INVALID', 'The sign-in could not be verified');
  }

  /** One exchange per token. The key is a hash (the token itself is never stored) and lives as long as the token could still verify. */
  private async consumeToken(idToken: string, identity: VerifiedFirebaseIdentity): Promise<void> {
    const remainingSeconds = Math.ceil((identity.expiresAt.getTime() - Date.now()) / 1000);
    const ttl = Math.min(Math.max(remainingSeconds, 60) + 60, 7200);
    const first = await this.store.setIfAbsent(`firebase-token:${sha256(idToken)}`, '1', ttl);
    if (!first) throw unauthorized('FIREBASE_TOKEN_REPLAYED', 'This sign-in was already used. Verify your phone number again');
  }

  // ---------------------------------------------------------------- account ownership

  private findByPhone(phone: string): Promise<Account | null> {
    return this.prisma.user.findUnique({ where: { phone }, include: WITH_ACCOUNT });
  }

  private async decide(existing: Account | null, identity: VerifiedFirebaseIdentity, meta: ClientMeta): Promise<Outcome> {
    if (!existing) return 'create';
    if (existing.roles.some((r) => r.role === Role.ADMIN)) {
      await this.refused(existing, identity, 'administrator_account', meta);
      throw forbidden('ACCOUNT_NOT_ELIGIBLE', 'This account cannot sign in with a phone number');
    }
    if (existing.status === UserStatus.SUSPENDED) throw forbidden('ACCOUNT_SUSPENDED', 'This account has been suspended. Contact support');
    if (existing.status === UserStatus.DEACTIVATED) throw forbidden('ACCOUNT_DEACTIVATED', 'This account has been deactivated. Contact support');
    if (!existing.phoneVerifiedAt) {
      await this.refused(existing, identity, 'phone_never_verified', meta);
      throw this.linkConflict('ACCOUNT_LINK_REVIEW_REQUIRED');
    }
    const bound = await this.boundUid(existing.id);
    if (bound === identity.uid) return 'sign_in';
    if (bound === null) {
      if (!this.allowAdoption) {
        await this.refused(existing, identity, 'no_recorded_firebase_identity', meta);
        throw this.linkConflict('ACCOUNT_LINK_REVIEW_REQUIRED');
      }
      return 'adopt';
    }
    if (!this.allowAdoption) {
      await this.refused(existing, identity, 'different_firebase_identity', meta);
      throw this.linkConflict('FIREBASE_IDENTITY_CONFLICT');
    }
    return 'change';
  }

  private linkConflict(code: 'ACCOUNT_LINK_REVIEW_REQUIRED' | 'FIREBASE_IDENTITY_CONFLICT'): ApiError {
    return new ApiError(HttpStatus.CONFLICT, code, 'This phone number is already linked to an account that needs a manual check. Contact support');
  }

  /** The Firebase user id recorded for an account by its latest binding entry, or null. */
  private async boundUid(userId: string): Promise<string | null> {
    const row = await this.prisma.auditLog.findFirst({
      where: { actorUserId: userId, action: FIREBASE_BOUND_ACTION },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { metadata: true },
    });
    const uid = (row?.metadata as Record<string, unknown> | null)?.['firebaseUid'];
    return typeof uid === 'string' ? uid : null;
  }

  private refused(account: Account, identity: VerifiedFirebaseIdentity, reason: string, meta: ClientMeta): Promise<void> {
    return this.audit.record({
      action: 'auth.firebase_link_refused',
      actorUserId: account.id,
      entityType: 'user',
      entityId: account.id,
      metadata: { reason, firebaseUid: identity.uid },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  private bindingEntry(userId: string, identity: VerifiedFirebaseIdentity, reason: 'created' | 'adopted' | 'changed', meta: ClientMeta): Prisma.AuditLogUncheckedCreateInput {
    return {
      action: FIREBASE_BOUND_ACTION,
      actorUserId: userId,
      entityType: 'user',
      entityId: userId,
      metadata: redactAuditMetadata({ firebaseUid: identity.uid, reason }),
      ipAddress: meta.ip?.slice(0, 45),
      userAgent: meta.userAgent?.slice(0, 512),
    };
  }

  // ---------------------------------------------------------------- writes

  private async apply(outcome: Outcome, existing: Account | null, phone: string, role: Role, identity: VerifiedFirebaseIdentity, meta: ClientMeta): Promise<{ user: Account; isNewUser: boolean }> {
    if (outcome === 'create') {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            phone,
            status: UserStatus.ACTIVE,
            phoneVerifiedAt: new Date(),
            roles: { create: [{ role }] },
            ...(role === Role.WORKER
              ? { workerProfile: { create: { verificationStatus: WorkerVerificationStatus.NOT_SUBMITTED } } }
              : { customerProfile: { create: {} } }),
          },
          include: WITH_ACCOUNT,
        });
        await tx.auditLog.create({ data: { action: 'user.registered', actorUserId: created.id, entityType: 'user', entityId: created.id, metadata: { role, method: 'firebase_phone' }, ipAddress: meta.ip?.slice(0, 45), userAgent: meta.userAgent?.slice(0, 512) } });
        await tx.auditLog.create({ data: this.bindingEntry(created.id, identity, 'created', meta) });
        return created;
      });
      return { user, isNewUser: true };
    }

    const account = existing!;
    const needsRole = !account.roles.some((r) => r.role === role);
    const needsActivation = account.status === UserStatus.PENDING_VERIFICATION;
    const binding = outcome === 'adopt' ? 'adopted' : outcome === 'change' ? 'changed' : null;
    if (!needsRole && !needsActivation && !binding) return { user: account, isNewUser: false };

    const user = await this.prisma.$transaction(async (tx: Tx) => {
      const updated = await tx.user.update({
        where: { id: account.id },
        data: {
          ...(needsActivation ? { status: UserStatus.ACTIVE } : {}),
          ...(needsRole ? { roles: { create: [{ role }] } } : {}),
          ...(needsRole && role === Role.CUSTOMER && !account.customerProfile ? { customerProfile: { create: {} } } : {}),
          ...(needsRole && role === Role.WORKER && !account.workerProfile ? { workerProfile: { create: { verificationStatus: WorkerVerificationStatus.NOT_SUBMITTED } } } : {}),
        },
        include: WITH_ACCOUNT,
      });
      if (needsRole) {
        await tx.auditLog.create({ data: { action: 'user.role_granted', actorUserId: account.id, entityType: 'user', entityId: account.id, metadata: { role, grantedBy: 'self_signup' }, ipAddress: meta.ip?.slice(0, 45), userAgent: meta.userAgent?.slice(0, 512) } });
      }
      if (binding) {
        await tx.auditLog.create({ data: this.bindingEntry(account.id, identity, binding, meta) });
        if (binding === 'changed') {
          await tx.auditLog.create({ data: { action: 'auth.firebase_identity_changed', actorUserId: account.id, entityType: 'user', entityId: account.id, metadata: { firebaseUid: identity.uid }, ipAddress: meta.ip?.slice(0, 45), userAgent: meta.userAgent?.slice(0, 512) } });
        }
      }
      return updated;
    });
    return { user, isNewUser: false };
  }
}
