import type { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * Test-only: removes the audit rows a suite created. audit_logs is append-only at the database (see migration
 * 20261030090000_audit_log_integrity), so the delete trigger is lifted inside one transaction and restored before it ends.
 * Refuses to run against any database other than "home_services_test".
 */
export async function purgeAuditLogsSince(prisma: PrismaClient, since: Date): Promise<void> {
  const [{ db }] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
  if (db !== 'home_services_test') throw new Error(`Refusing to purge audit logs: "${db}" is not the test database`);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only');
    try {
      await tx.auditLog.deleteMany({ where: { createdAt: { gte: since } } });
    } finally {
      await tx.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only');
    }
  });
}
