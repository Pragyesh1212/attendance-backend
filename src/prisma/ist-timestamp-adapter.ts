/**
 * AttendEase's opted-in IST-wall-clock persistence adapter.
 *
 * Database TIMESTAMP WITHOUT TIME ZONE columns contain Asia/Kolkata local
 * clock values, while application-level JavaScript Dates continue to denote
 * real UTC instants. The standard PrismaPg adapter uses UTC for TIMESTAMPs,
 * so we translate at the adapter boundary in both directions.
 *
 * THIS IS ONLY FOR TIMESTAMP WITHOUT TIME ZONE. It deliberately excludes
 * DATE (workDate, joiningDate) and TIMESTAMPTZ.
 *
 * Must only be enabled together with the one-time conversion migration.
 * Test against a Neon backup branch before enabling in production.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { ColumnTypeEnum } from '@prisma/driver-adapter-utils';
import type {
  ArgType,
  SqlDriverAdapter,
  SqlDriverAdapterFactory,
  SqlQuery,
  SqlResultSet,
  Transaction,
} from '@prisma/driver-adapter-utils';

const IST_OFFSET_MS = 330 * 60_000;

// Every TIMESTAMP column from the uploaded Prisma schema (except joiningDate,
// which the accompanying migration changes to the DATE type).
// Filtering by column name also avoids changing SELECT NOW() / timestamptz
// returned by an unrelated raw query.
const storedIstTimestampColumns = new Set([
  'emailVerifiedAt', 'lastLoginAt',
  'createdAt', 'updatedAt',
  'punchInAt', 'punchOutAt', 'reviewedAt',
  'startAt', 'endAt',
  'originalPunchInAt', 'originalPunchOutAt',
  'requestedPunchInAt', 'requestedPunchOutAt',
  'readAt', 'approvedAt', 'revokedAt', 'lastSeenAt',
  'expiresAt', 'usedAt',
  'leftAt', 'returnedAt',
]);

function shiftDate(value: unknown, milliseconds: number): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(item => shiftDate(item, milliseconds));
  if (typeof value !== 'string' && !(value instanceof Date)) return value;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    throw new Error('Unparseable TIMESTAMP parameter/result: refusing an unsafe date conversion');
  }
  return new Date(time + milliseconds).toISOString();
}

function isTimestampArgument(type: ArgType | undefined): boolean {
  if (!type || type.scalarType !== 'datetime') return false;
  // DATE and TIME types must not be shifted. TIMESTAMPTZ, when introduced,
  // must stay a true absolute instant too.
  const dbType = (type.dbType ?? 'TIMESTAMP').toUpperCase();
  return /^TIMESTAMP(?:\(\d+\))?$/.test(dbType);
}

function toIstQuery(query: SqlQuery): SqlQuery {
  return {
    ...query,
    args: query.args.map((arg, i) => isTimestampArgument(query.argTypes[i])
      ? shiftDate(arg, IST_OFFSET_MS) : arg),
  };
}

function toUtcResult(result: SqlResultSet): SqlResultSet {
  const indices = result.columnNames.map((name, i) =>
    result.columnTypes[i] === ColumnTypeEnum.DateTime &&
      storedIstTimestampColumns.has(name) ? i : -1).filter(i => i >= 0);
  if (!indices.length) return result;
  return {
    ...result,
    rows: result.rows.map(row => {
      const converted = [...row];
      for (const i of indices) {
        converted[i] = shiftDate(converted[i], -IST_OFFSET_MS);
      }
      return converted;
    }),
  };
}

function wrapTransaction(transaction: Transaction): Transaction {
  return {
    provider: transaction.provider,
    adapterName: transaction.adapterName,
    options: transaction.options,
    queryRaw: async query => toUtcResult(await transaction.queryRaw(toIstQuery(query))),
    executeRaw: query => transaction.executeRaw(toIstQuery(query)),
    commit: () => transaction.commit(),
    rollback: () => transaction.rollback(),
    ...(transaction.createSavepoint && {
      createSavepoint: (name: string) => transaction.createSavepoint!(name),
    }),
    ...(transaction.rollbackToSavepoint && {
      rollbackToSavepoint: (name: string) => transaction.rollbackToSavepoint!(name),
    }),
    ...(transaction.releaseSavepoint && {
      releaseSavepoint: (name: string) => transaction.releaseSavepoint!(name),
    }),
  };
}

function wrapAdapter(adapter: SqlDriverAdapter): SqlDriverAdapter {
  return {
    provider: adapter.provider,
    adapterName: adapter.adapterName,
    queryRaw: async query => toUtcResult(await adapter.queryRaw(toIstQuery(query))),
    executeRaw: query => adapter.executeRaw(toIstQuery(query)),
    startTransaction: async isolationLevel =>
      wrapTransaction(await adapter.startTransaction(isolationLevel)),
    executeScript: script => adapter.executeScript(script),
    // Relation joins may return nested TIMESTAMP values inside JSONB blobs,
    // which do not expose their SQL column types to this converter.
    // Force regular relation queries so each TIMESTAMP is decoded reliably.
    getConnectionInfo: adapter.getConnectionInfo
      ? () => ({ ...adapter.getConnectionInfo!(), supportsRelationJoins: false })
      : undefined,
    dispose: () => adapter.dispose(),
  };
}

export function istWallClockAdapter(inner: PrismaPg): SqlDriverAdapterFactory {
  return {
    provider: inner.provider,
    adapterName: inner.adapterName,
    connect: async () => wrapAdapter(await inner.connect()),
  };
}
