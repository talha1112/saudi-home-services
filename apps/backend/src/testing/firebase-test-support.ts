import { randomBytes, randomUUID } from 'node:crypto';
import {
  FirebaseIdentityVerifier,
  FirebaseVerificationError,
  type FirebaseVerificationFailure,
  type VerifiedFirebaseIdentity,
} from '../modules/auth/firebase/firebase-identity-verifier.js';

/**
 * TEST DOUBLE for the Firebase boundary. It signs nothing and trusts nothing: a "token" is just a random JWT-shaped string that this object
 * remembers, so a token it did not mint is INVALID, exactly like a forged one. Real signature checking belongs to the Firebase Admin SDK and
 * is only exercised against a Firebase project or the Auth Emulator.
 */
export class FakeFirebaseIdentityVerifier extends FirebaseIdentityVerifier {
  enabled = true;
  verifyCalls = 0;
  private readonly issued = new Map<string, VerifiedFirebaseIdentity | FirebaseVerificationFailure>();

  private shape(): string {
    const part = (n: number) => randomBytes(n).toString('base64url');
    return `${part(36)}.${part(120)}.${part(96)}`; // header.payload.signature, long enough for the DTO's shape check
  }

  /** A token the "SDK" accepts. Defaults describe a person who just verified a phone number. */
  mint(overrides: Partial<VerifiedFirebaseIdentity> & { phoneNumber?: string | undefined } = {}): string {
    const now = Date.now();
    const token = this.shape();
    this.issued.set(token, {
      uid: `uid-${randomUUID()}`,
      phoneNumber: '+966501234567',
      signInProvider: 'phone',
      authTime: new Date(now - 5_000),
      issuedAt: new Date(now - 5_000),
      expiresAt: new Date(now + 3_600_000),
      ...overrides,
    });
    return token;
  }

  /** A token the "SDK" refuses for the given reason (expired, revoked, wrong project, ...). */
  mintFailure(kind: FirebaseVerificationFailure): string {
    const token = this.shape();
    this.issued.set(token, kind);
    return token;
  }

  async verify(idToken: string): Promise<VerifiedFirebaseIdentity> {
    this.verifyCalls += 1;
    const found = this.issued.get(idToken);
    if (found === undefined) throw new FirebaseVerificationError('INVALID');
    if (typeof found === 'string') throw new FirebaseVerificationError(found);
    return found;
  }
}
