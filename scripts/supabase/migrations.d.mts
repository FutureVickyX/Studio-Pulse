// Types for migrations.mjs.

export interface Migration {
  /** Digits before the first `_` of the file name. */
  version: string;
  name: string;
  file: string;
  path: string;
}

export interface MigrationPlan {
  pending: Migration[];
  applied: Migration[];
  unknownApplied: string[];
  outOfOrder: Migration[];
}

/** The part of `pg.Client` the runner uses. */
export interface Queryable {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type ApplyResult =
  | { status: 'applied'; applied: Migration[]; skipped: Migration[] }
  | { status: 'refused'; reason: 'unknownApplied' | 'outOfOrder'; versions: string[] }
  | { status: 'failed'; applied: Migration[]; failed: Migration; error: unknown };

export interface ConnectionConfig {
  config: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl: false | { rejectUnauthorized: boolean; ca?: string[] };
    application_name: string;
    connectionTimeoutMillis: number;
  };
  secrets: string[];
  local: boolean;
}

export declare const MIGRATION_FILE: RegExp;
export declare const HISTORY_TABLE_DDL: readonly string[];
export declare const ADVISORY_LOCK_KEY: number;
export declare const TLS_VERIFY_ERRORS: ReadonlySet<string>;

export declare function listMigrations(dir: string): { migrations: Migration[]; ignored: string[] };
export declare function compareFilenames(a: string, b: string): number;
export declare function compareVersions(a: string, b: string): number;
export declare function planMigrations(local: readonly Migration[], appliedVersions: Iterable<string>): MigrationPlan;
export declare function splitStatements(sql: string): string[];
export declare function findTransactionUnsafeStatements(statements: readonly string[]): { index: number; reason: string }[];
export declare function readMigration(migration: Migration): { sql: string; statements: string[] };
export declare function readAppliedVersions(db: Queryable): Promise<string[]>;
export declare function applyMigrations(
  db: Queryable,
  migrations: readonly Migration[],
  options?: {
    includeAll?: boolean;
    onApplied?: (migration: Migration, statementCount: number) => void;
    onSkipped?: (migration: Migration) => void;
  },
): Promise<ApplyResult>;
export declare function trustedCertificates(extraPem?: string): string[];
export declare function connectionConfig(
  url: string,
  options?: { ca?: string; noVerify?: boolean; applicationName?: string },
): ConnectionConfig;
export declare function redact(text: string, secrets: readonly string[]): string;
export declare function describeError(error: unknown, secrets: readonly string[]): string;
export declare function isTlsVerifyError(error: unknown): boolean;
