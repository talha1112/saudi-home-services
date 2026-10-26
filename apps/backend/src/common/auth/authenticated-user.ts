import type { Role, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';

/** The caller of a request, as established by JwtAuthGuard from a verified token and the live database row. */
export interface AuthenticatedUser {
  id: string;
  /** Session (refresh-token family) the access token belongs to. */
  sessionId: string;
  /** The role this session acts as: customer app, worker app or admin portal. */
  role: Role;
  /** Every role the person holds (a person can be both customer and worker). */
  roles: Role[];
  status: UserStatus;
  mustChangePassword: boolean;
  /** Present when the person has a worker profile. */
  workerVerificationStatus?: WorkerVerificationStatus;
}

export interface RequestWithUser {
  user?: AuthenticatedUser;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}
