import { Injectable, Logger } from '@nestjs/common';
import { describeError } from '../../common/logging/safe-error.js';
import { PrismaService } from '../../database/prisma.service.js';

export interface AuditEntry {
  action: string;
  actorUserId?: string | null;
  entityType: string;
  entityId?: string;
  /** Small non-sensitive context. Never put codes, passwords or tokens here. */
  metadata?: Record<string, string | number | boolean | null>;
  ipAddress?: string;
  userAgent?: string;
}

/** Keys whose values must never be written to the audit log, whatever a caller passes. */
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|signature|signed|credential|otp|storage_?key|url|[a-z]url$/i;
/** Values that look like credentials or signed links, whatever their key. */
const SENSITIVE_VALUE = /^Bearer\s|^eyJ[\w-]+\.[\w-]+\.|[?&](X-Amz-|sig=|signature=|token=)|-----BEGIN /i;
const MAX_VALUE_LENGTH = 300;

export const REDACTED = '[redacted]';

/**
 * Defence in depth for the audit trail: every entry passes through here, so a careless caller cannot put a password,
 * token, secret, signed storage URL or credential-looking value into `audit_logs`. Strings are also truncated so a pasted
 * document or message cannot end up there. Callers should still pass only small, non-personal context.
 */
export function redactAuditMetadata(metadata: AuditEntry['metadata']): AuditEntry['metadata'] {
  if (!metadata) return metadata;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = REDACTED;
    } else if (typeof value === 'string') {
      out[key] = SENSITIVE_VALUE.test(value) ? REDACTED : value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}...` : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Best effort: an audit-write failure is logged but never fails the user's request. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          actorUserId: entry.actorUserId ?? null,
          entityType: entry.entityType,
          entityId: entry.entityId,
          metadata: redactAuditMetadata(entry.metadata),
          ipAddress: entry.ipAddress?.slice(0, 45),
          userAgent: entry.userAgent?.slice(0, 512),
        },
      });
    } catch (err) {
      this.logger.error(`Failed to write audit log "${entry.action}": ${describeError(err)}`); // never the raw database text: it can quote the entry being written
    }
  }
}
