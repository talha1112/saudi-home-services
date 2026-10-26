import { Injectable } from '@nestjs/common';

/**
 * What the server learned from a Firebase ID token AFTER the signature, issuer, audience and expiry were verified.
 * Nothing in here comes from the client except through that verification.
 */
export interface VerifiedFirebaseIdentity {
  /** The Firebase user id. An identifier for this sign-in only; it is not stored in a column. */
  uid: string;
  /** The phone number exactly as Firebase certified it (E.164), or undefined when the token has no phone claim. */
  phoneNumber: string | undefined;
  /** How the person signed in to Firebase: "phone", "anonymous", "password", "google.com", "custom", ... */
  signInProvider: string;
  /** When the person last completed a real Firebase sign-in (SMS code), not when the token was minted. */
  authTime: Date;
  issuedAt: Date;
  expiresAt: Date;
}

/**
 * Why a token was refused. The kinds are the only thing that crosses this boundary (never the SDK's message, which could quote the token).
 *  INVALID: not a token this project issued (bad signature, wrong project, malformed); REVOKED / USER_DISABLED: Firebase says no;
 *  EXPIRED: the token's own lifetime ended; UNAVAILABLE: Firebase or its keys could not be reached (not the caller's fault);
 *  NOT_CONFIGURED: the feature is switched off.
 */
export type FirebaseVerificationFailure = 'INVALID' | 'EXPIRED' | 'REVOKED' | 'USER_DISABLED' | 'UNAVAILABLE' | 'NOT_CONFIGURED';

export class FirebaseVerificationError extends Error {
  constructor(readonly kind: FirebaseVerificationFailure) {
    super(`FIREBASE_${kind}`);
  }
}

/** The boundary to Firebase. The real adapter uses the Firebase Admin SDK; tests use a double. Tokens are bearer secrets: never log them. */
export abstract class FirebaseIdentityVerifier {
  /** False when Firebase phone sign-in is switched off. */
  abstract readonly enabled: boolean;
  abstract verify(idToken: string): Promise<VerifiedFirebaseIdentity>;
}

/** Used when FIREBASE_AUTH_ENABLED is not true. Fails closed. */
@Injectable()
export class DisabledFirebaseIdentityVerifier extends FirebaseIdentityVerifier {
  readonly enabled = false;
  async verify(): Promise<never> {
    throw new FirebaseVerificationError('NOT_CONFIGURED');
  }
}
