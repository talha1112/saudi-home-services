import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Role, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import type { RequestWithUser } from '../auth/authenticated-user.js';
import { forbidden } from '../errors/api-error.js';

/** Blocks workers whose verification is not APPROVED (pending, rejected or never submitted). */
@Injectable()
export class ApprovedWorkerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<RequestWithUser>().user;
    if (user?.role !== Role.WORKER) {
      throw forbidden('INSUFFICIENT_ROLE', 'Your account type cannot perform this action');
    }
    if (user.workerVerificationStatus !== WorkerVerificationStatus.APPROVED) {
      throw forbidden('WORKER_NOT_APPROVED', 'Your worker account has not been approved yet');
    }
    return true;
  }
}
