import { Injectable } from '@nestjs/common';

export interface MfaSubject {
  id: string;
  email: string | null;
}

/**
 * Extension point for multi-factor authentication of administrators.
 *
 * AdminAuthService calls `isRequired` after the password has been verified. When
 * it returns true the login must also present a valid `mfaCode`, checked by
 * `verify`. Today nothing requires MFA; to add TOTP later, provide a class that
 * implements this contract (secret storage + otplib or similar) and bind it to
 * `AdminMfaPolicy` in AuthModule. No change to the login flow is needed.
 */
export abstract class AdminMfaPolicy {
  abstract isRequired(subject: MfaSubject): Promise<boolean>;
  abstract verify(subject: MfaSubject, code: string | undefined): Promise<boolean>;
}

@Injectable()
export class NoMfaPolicy extends AdminMfaPolicy {
  async isRequired(): Promise<boolean> {
    return false;
  }

  async verify(): Promise<boolean> {
    return true;
  }
}
