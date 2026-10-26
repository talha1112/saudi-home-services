import { Logger, type OnModuleDestroy } from '@nestjs/common';
// Type-only imports: the SDK itself is loaded on first use (see auth()), so merely importing this file, as every test that boots the
// application does, never loads firebase-admin. (Jest's module loader cannot load it; Node can.)
import type { App } from 'firebase-admin/app';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { FirebaseConfig } from '../../../config/app.config.js';
import { FirebaseIdentityVerifier, FirebaseVerificationError, type VerifiedFirebaseIdentity } from './firebase-identity-verifier.js';

/** The one SDK call this adapter makes, so tests can stand in for the SDK. */
export interface FirebaseTokenAuth {
  verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
}

/**
 * Maps the SDK's error codes to our failure kinds. Unknown errors are UNAVAILABLE (a 503, never a 401): a surprise must not look like a
 * bad token, and must not be retried by the caller as if it were. Only the code is ever logged.
 */
export function classifySdkError(err: unknown): FirebaseVerificationError {
  const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : '';
  switch (code) {
    case 'auth/id-token-expired':
      return new FirebaseVerificationError('EXPIRED');
    case 'auth/id-token-revoked':
    case 'auth/user-not-found': // a valid token for a user who has since been deleted
      return new FirebaseVerificationError('REVOKED');
    case 'auth/user-disabled':
      return new FirebaseVerificationError('USER_DISABLED');
    case 'auth/argument-error':
    case 'auth/invalid-id-token':
      return new FirebaseVerificationError('INVALID');
    default:
      return new FirebaseVerificationError('UNAVAILABLE');
  }
}

/**
 * Verifies Firebase ID tokens with the Firebase Admin SDK (signature against Google's published keys, expiry, issuer and audience), then
 * re-checks audience and issuer against the configured project itself, so a token minted for ANOTHER Firebase project can never pass even if
 * the SDK were misconfigured.
 *
 * Credentials: verifying a token needs only the project id. The service account (a backend secret) is used only for the optional revocation
 * check. It is read from configuration, never logged, and never leaves this process.
 */
export class FirebaseAdminVerifier extends FirebaseIdentityVerifier implements OnModuleDestroy {
  readonly enabled = true;
  private readonly logger = new Logger(FirebaseAdminVerifier.name);
  private authClient?: FirebaseTokenAuth;
  private app?: App;

  constructor(
    private readonly config: FirebaseConfig,
    private readonly authFactory?: () => FirebaseTokenAuth,
  ) {
    super();
  }

  async verify(idToken: string): Promise<VerifiedFirebaseIdentity> {
    const projectId = this.config.auth.projectId;
    if (!projectId) throw new FirebaseVerificationError('NOT_CONFIGURED');

    let decoded: DecodedIdToken;
    try {
      decoded = await (await this.auth()).verifyIdToken(idToken, this.config.auth.checkRevoked);
    } catch (err) {
      const failure = classifySdkError(err);
      if (failure.kind === 'UNAVAILABLE') {
        const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : 'no-code';
        this.logger.warn(`Firebase token verification unavailable (${code})`); // the code only: SDK messages can quote the token
      }
      throw failure;
    }

    const uid = typeof decoded.uid === 'string' ? decoded.uid : '';
    if (decoded.aud !== projectId || decoded.iss !== `https://securetoken.google.com/${projectId}` || uid.length === 0 || uid.length > 128) {
      throw new FirebaseVerificationError('INVALID');
    }
    const authTime = Number(decoded.auth_time);
    if (!Number.isFinite(authTime) || !Number.isFinite(decoded.iat) || !Number.isFinite(decoded.exp)) throw new FirebaseVerificationError('INVALID');
    return {
      uid,
      phoneNumber: typeof decoded.phone_number === 'string' ? decoded.phone_number : undefined,
      signInProvider: typeof decoded.firebase?.sign_in_provider === 'string' ? decoded.firebase.sign_in_provider : 'unknown',
      authTime: new Date(authTime * 1000),
      issuedAt: new Date(decoded.iat * 1000),
      expiresAt: new Date(decoded.exp * 1000),
    };
  }

  /** Created on first use, so start-up never depends on Firebase. */
  private async auth(): Promise<FirebaseTokenAuth> {
    if (this.authClient) return this.authClient;
    if (this.authFactory) {
      this.authClient = this.authFactory();
      return this.authClient;
    }
    const { cert, getApps, initializeApp } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const projectId = this.config.auth.projectId!;
    const name = `hs-firebase-auth-${projectId}`;
    const sa = this.config.serviceAccount;
    this.app =
      getApps().find((a) => a.name === name) ??
      initializeApp({ projectId, ...(sa ? { credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }) } : {}) }, name);
    this.authClient = getAuth(this.app);
    return this.authClient;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.app) {
      const { deleteApp } = await import('firebase-admin/app');
      await deleteApp(this.app).catch(() => undefined);
    }
  }
}
