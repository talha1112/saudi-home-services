import type { Locale, Role, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import type { AuthUserDto } from './dto/auth.dto.js';

interface UserRecord {
  id: string;
  phone: string | null;
  email: string | null;
  fullName: string | null;
  locale: Locale;
  status: UserStatus;
  mustChangePassword: boolean;
  roles: { role: Role }[];
  workerProfile?: { verificationStatus: WorkerVerificationStatus } | null;
}

/**
 * The only way a user leaves the auth layer. It is an allow-list, so columns
 * such as passwordHash can never leak by being added to the table later.
 */
export function toAuthUser(user: UserRecord, activeRole: Role): AuthUserDto {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    fullName: user.fullName,
    locale: user.locale,
    status: user.status,
    roles: user.roles.map((r) => r.role),
    activeRole,
    workerVerificationStatus: user.workerProfile?.verificationStatus,
    mustChangePassword: user.mustChangePassword,
  };
}
