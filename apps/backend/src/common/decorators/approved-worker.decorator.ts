import { applyDecorators, UseGuards } from '@nestjs/common';
import { Role } from '../../generated/prisma/client.js';
import { ApprovedWorkerGuard } from '../guards/approved-worker.guard.js';
import { Roles } from './roles.decorator.js';

/** Worker job operations: the session must act as a WORKER whose verification is APPROVED. */
export const RequireApprovedWorker = () => applyDecorators(Roles(Role.WORKER), UseGuards(ApprovedWorkerGuard));
