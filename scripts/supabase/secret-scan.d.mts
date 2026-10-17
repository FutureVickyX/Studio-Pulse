// Types for secret-scan.mjs.

export interface Literal {
  kind: string;
  value: string;
}

export interface Finding {
  kind: string;
  count: number;
  /** Byte offset of the first match. */
  firstOffset: number;
  encoding: 'utf8' | 'utf16le';
}

export interface AllowEntry {
  kinds: readonly string[];
  reason: string;
  /** Repository-relative path (forward slashes) of a source file. */
  path?: string;
  /** File-name pattern of a build output. */
  binaryName?: RegExp;
}

export interface Reported {
  file: string;
  kind: string;
  count: number;
  location: string;
  allowed?: string;
}

export declare const LEAK_KINDS: readonly string[];
export declare const REFERENCE_KINDS: readonly string[];
export declare const DEFAULT_ALLOWLIST: readonly AllowEntry[];

export declare function scanBuffer(buf: Buffer, options?: { literals?: readonly Literal[] }): Finding[];
export declare function configuredLiterals(values: Readonly<Record<string, string>>): Literal[];
export declare function allowedBy(file: string, kind: string, allowlist: readonly AllowEntry[]): AllowEntry | undefined;
export declare function listFiles(path: string): string[];
export declare function defaultTargets(env?: NodeJS.ProcessEnv): { path: string; label: string }[];
export declare function scanFiles(
  files: readonly string[],
  options?: { literals?: readonly Literal[]; allowlist?: readonly AllowEntry[] },
): { failures: Reported[]; allowed: Reported[]; skipped: string[]; scanned: number; bytes: number };
export declare function main(
  argv: string[],
  io?: { out?: (line: string) => void; err?: (line: string) => void; env?: NodeJS.ProcessEnv },
): number;
