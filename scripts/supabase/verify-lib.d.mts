// Types for verify-lib.mjs.

export interface EntryPayload {
  id?: string;
  deviceId: string;
  applicationId: string;
  applicationName: string;
  kind: string;
  startedAt: string;
  endedAt: string;
  activeMs: number;
  idleMs: number;
  endReason: string;
  projectId?: string | null;
  taskId?: string | null;
  revision?: number;
  recordedAt?: string;
}

export interface InvalidEntryVariant {
  name: string;
  /** SQLSTATE `sync_time_entries` reports in the rejected result's detail. */
  sqlstate: string;
  apply(entry: EntryPayload): EntryPayload;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  reason?: string;
}

export interface LiveTestCredentials {
  email: string;
  password: string;
  userId: string;
  workspaceId: string;
}

export declare function newRunId(): string;
export declare function verifyEmail(runId: string, label: string): string;
export declare function liveTestEmail(runId: string): string;
export declare const LIVE_TEST_EMAIL_PATTERN: RegExp;
export declare function generatePassword(): string;
export declare function uuidv7(ms?: number): string;
export declare function newDeviceId(): string;

export declare function buildEntry(spec: {
  deviceId: string;
  startMs: number;
  durationMs: number;
  kind?: 'active' | 'idle';
  applicationId?: string;
  applicationName?: string;
  endReason?: string;
  projectId?: string | null;
  taskId?: string | null;
}): EntryPayload & { id: string };
export declare const INVALID_ENTRY_VARIANTS: readonly InvalidEntryVariant[];
export declare function detailSqlstate(detail: unknown): string | null;

export declare class CheckFailure extends Error {}
export declare class AbortRun extends Error {}
export declare class CheckRecorder {
  constructor(options?: { out?: (line: string) => void; secrets?: () => readonly string[] });
  results: CheckResult[];
  redactLine(text: string): string;
  check<T>(name: string, fn: () => Promise<T> | T, options?: { required?: boolean }): Promise<T | undefined>;
  readonly passed: number;
  readonly failed: number;
  summary(): string;
}

export declare const expect: {
  that(condition: unknown, message: string): void;
  ok<T>(result: { data?: T; error?: unknown }, what: string): T;
  denied(result: { data?: unknown; error?: unknown }, what: string, codes?: readonly string[]): void;
  noRows(result: { data?: unknown; error?: unknown }, what: string): void;
};
export declare function errorCode(error: unknown): string | null;
export declare function describeSupabaseError(error: unknown): string;

export declare const LIVE_TEST_FILE: string;
export declare const LIVE_TEST_KEYS: Readonly<Record<keyof LiveTestCredentials, string>>;
export declare const LIVE_TEST_PUBLIC_KEYS: Readonly<{ url: string; publishableKey: string }>;
export declare function formatLiveTestFile(creds: LiveTestCredentials & { url?: string; publishableKey?: string }): string;
export declare function parseLiveTestFile(text: string): LiveTestCredentials | null;
export declare function isGitIgnored(path: string): boolean | null;
export declare function normaliseProjectUrl(raw: string): string;
