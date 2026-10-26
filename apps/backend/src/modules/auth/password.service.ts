import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { badRequest } from '../../common/errors/api-error.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Argon2id (the library defaults follow the OWASP minimum: 19 MiB, 2 passes).
 * The encoded hash embeds its parameters, so they can be raised later without
 * breaking existing hashes.
 */
@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return hash(password);
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }

  /** Spend the same time as a real check when the account does not exist, so response time does not reveal it. */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= hash('timing-equaliser-not-a-real-password');
    await this.verify(await this.dummyHash, password);
  }

  /** Throws a 400 with a clear message when the password is not acceptable. */
  assertAcceptable(password: string, context: { email?: string | null } = {}): void {
    if (password.length < PASSWORD_MIN_LENGTH) {
      throw badRequest('WEAK_PASSWORD', `Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      throw badRequest('WEAK_PASSWORD', `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
    }
    if (!/\p{L}/u.test(password) || !/[^\p{L}]/u.test(password)) {
      throw badRequest('WEAK_PASSWORD', 'Password must mix letters with numbers or symbols');
    }
    if (new Set(password).size < 5) {
      throw badRequest('WEAK_PASSWORD', 'Password is too repetitive');
    }
    const local = context.email?.split('@')[0]?.toLowerCase();
    if (local && local.length >= 4 && password.toLowerCase().includes(local)) {
      throw badRequest('WEAK_PASSWORD', 'Password must not contain your email name');
    }
  }
}
