import { prisma } from '../../../db/prisma-client';
import type { Prisma, VerificationStatus } from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function findDoctorProfileByUserId(userId: string) {
  return prisma.doctorProfile.findUnique({ where: { userId } });
}

export function findDoctorProfileById(id: string, db: DbClient = prisma) {
  return db.doctorProfile.findUnique({ where: { id } });
}

/**
 * The optimistic-locking write (ARCHITECTURE.md §5.4, issue #49).
 *
 * One statement: the row is only updated if it still carries the version the
 * caller read, and that same statement bumps it. `updateManyAndReturn` gives
 * back the row *this* statement wrote, so the response the caller sees is the
 * state it produced — a re-read would be a second window in which someone
 * else's write could land first. Null means the guard didn't match: the
 * caller is stale and must re-read.
 */
export function updateDoctorProfile(id: string, version: number, fullName: string) {
  return prisma.doctorProfile
    .updateManyAndReturn({
      where: { id, version },
      data: { fullName, version: { increment: 1 } },
    })
    .then((rows) => rows[0] ?? null);
}

export function findDoctorSummariesByIds(ids: string[]) {
  return prisma.doctorProfile.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
}

/** Reads the current verification status with a row lock, inside a
 * transaction (issue #43): two admins changing it at once are serialised,
 * so each audit event records the state that was really replaced. */
export async function lockVerificationStatus(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<VerificationStatus | null> {
  const rows = await tx.$queryRaw<{ verificationStatus: VerificationStatus }[]>`
    SELECT "verificationStatus" FROM "DoctorProfile" WHERE "id" = ${id} FOR UPDATE
  `;
  return rows[0]?.verificationStatus ?? null;
}

export function updateVerificationStatus(db: DbClient, id: string, status: VerificationStatus) {
  return db.doctorProfile.update({ where: { id }, data: { verificationStatus: status, version: { increment: 1 } } });
}
