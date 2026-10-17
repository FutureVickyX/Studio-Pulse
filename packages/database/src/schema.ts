/**
 * A runtime description of the remote schema, tied to the hand-written `Database` type in both
 * directions:
 *
 * - at compile time, the assertions at the bottom of this file fail `tsc` if a table, column,
 *   nullability, default, enum, relationship or function signature here differs from
 *   `src/types.ts`;
 * - at test time, `tests/unit/database/schema.test.ts` applies `supabase/migrations/*.sql` to a
 *   real Postgres (PGlite) and compares the catalog with this description.
 *
 * Together: migrations ⇄ this file ⇄ `Database`. Exported because the enum value lists are useful
 * to callers (pickers, validation); the column descriptions are mainly for that test.
 */

import type { Database, Json, TimeEntryEndReason } from './types';

// ---------------------------------------------------------------------------------------------
// Enums and constrained text values
// ---------------------------------------------------------------------------------------------

/** Postgres enum values, in declaration order (same shape as the generator's `Constants`). */
export const Constants = {
  public: {
    Enums: {
      workspace_role: ['owner', 'admin', 'member'],
      membership_status: ['active', 'removed'],
      time_entry_visibility: ['private', 'admins'],
      project_status: ['active', 'archived'],
      task_status: ['inbox', 'todo', 'in_progress', 'in_review', 'done', 'archived'],
      task_priority: ['low', 'normal', 'high', 'urgent'],
      note_visibility: ['private', 'workspace'],
    },
  },
} as const;

/** `time_entries.kind` (CHECK constraint). */
export const TIME_ENTRY_KINDS = ['active', 'idle'] as const;
/** `time_entries.end_reason` (CHECK constraint), in the order the migration lists them. */
export const TIME_ENTRY_END_REASONS = [
  'appSwitch',
  'becameIdle',
  'inputResumed',
  'untracked',
  'sessionAway',
  'paused',
  'disabled',
  'timeGap',
  'clockChange',
  'shutdown',
  'recovered',
  'settingsChanged',
] as const;
/** `time_entries.source` (CHECK constraint): only automatic tracker intervals are stored. */
export const TIME_ENTRY_SOURCES = ['automatic'] as const;
/** `sync_time_entries` result statuses (fixed by the function body). */
export const SYNC_ENTRY_STATUSES = ['synced', 'rejected'] as const;

// ---------------------------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------------------------

type EnumName = keyof Database['public']['Enums'];
type ScalarType = 'uuid' | 'text' | 'timestamptz' | 'date' | 'bigint' | 'integer' | 'boolean' | 'jsonb';
type BaseType = ScalarType | `enum:${EnumName}`;
/** Postgres type of a column or argument; `enum:<name>` for enums, a `[]` suffix for arrays. */
export type ColumnType = BaseType | `${BaseType}[]`;

export interface ColumnSpec {
  readonly type: ColumnType;
  readonly nullable: boolean;
  /** Has a column default (or, for a function argument, a parameter default). */
  readonly hasDefault: boolean;
  /** Allowed values of a text column restricted by `CHECK (col IN (...))` / `= '...'`. */
  readonly values?: readonly string[];
}

/** NOT NULL, no default: required on insert. */
function req<T extends ColumnType>(type: T) {
  return { type, nullable: false, hasDefault: false } as const;
}
/** NOT NULL with a default. */
function dflt<T extends ColumnType>(type: T) {
  return { type, nullable: false, hasDefault: true } as const;
}
/** Nullable, no default. */
function opt<T extends ColumnType>(type: T) {
  return { type, nullable: true, hasDefault: false } as const;
}
/** Nullable with a default (e.g. `created_by uuid default auth.uid()`). */
function optDflt<T extends ColumnType>(type: T) {
  return { type, nullable: true, hasDefault: true } as const;
}
function oneOf<C extends ColumnSpec, const V extends readonly string[]>(column: C, values: V) {
  return { ...column, values } as C & { readonly values: V };
}

/** Every table in `public`, every column in declaration order. */
export const TABLE_COLUMNS = {
  profiles: {
    id: req('uuid'),
    display_name: req('text'),
    created_at: dflt('timestamptz'),
    updated_at: dflt('timestamptz'),
  },
  workspaces: {
    id: dflt('uuid'),
    name: req('text'),
    time_entry_visibility: dflt('enum:time_entry_visibility'),
    created_by: opt('uuid'),
    created_at: dflt('timestamptz'),
    updated_at: dflt('timestamptz'),
  },
  workspace_members: {
    workspace_id: req('uuid'),
    user_id: req('uuid'),
    role: dflt('enum:workspace_role'),
    status: dflt('enum:membership_status'),
    joined_at: dflt('timestamptz'),
    updated_at: dflt('timestamptz'),
  },
  workspace_invitations: {
    id: dflt('uuid'),
    workspace_id: req('uuid'),
    email: req('text'),
    role: dflt('enum:workspace_role'),
    token_hash: req('text'),
    invited_by: opt('uuid'),
    expires_at: dflt('timestamptz'),
    accepted_at: opt('timestamptz'),
    accepted_by: opt('uuid'),
    revoked_at: opt('timestamptz'),
    created_at: dflt('timestamptz'),
  },
  projects: {
    id: dflt('uuid'),
    workspace_id: req('uuid'),
    name: req('text'),
    description: dflt('text'),
    status: dflt('enum:project_status'),
    created_by: optDflt('uuid'),
    created_at: dflt('timestamptz'),
    updated_at: dflt('timestamptz'),
  },
  tasks: {
    id: dflt('uuid'),
    workspace_id: req('uuid'),
    project_id: opt('uuid'),
    title: req('text'),
    description: dflt('text'),
    status: dflt('enum:task_status'),
    priority: dflt('enum:task_priority'),
    assignee_id: opt('uuid'),
    created_by: optDflt('uuid'),
    due_date: opt('date'),
    start_date: opt('date'),
    estimated_minutes: opt('integer'),
    completed_at: opt('timestamptz'),
    created_at: dflt('timestamptz'),
    updated_at: dflt('timestamptz'),
  },
  notes: {
    id: dflt('uuid'),
    workspace_id: req('uuid'),
    owner_id: dflt('uuid'),
    project_id: opt('uuid'),
    title: dflt('text'),
    body: dflt('text'),
    visibility: dflt('enum:note_visibility'),
    pinned: dflt('boolean'),
    version: dflt('integer'),
    created_at: dflt('timestamptz'),
    updated_at: dflt('timestamptz'),
  },
  time_entries: {
    id: req('uuid'),
    workspace_id: req('uuid'),
    user_id: dflt('uuid'),
    device_id: req('uuid'),
    application_id: req('text'),
    application_name: req('text'),
    kind: oneOf(req('text'), TIME_ENTRY_KINDS),
    started_at: req('timestamptz'),
    ended_at: req('timestamptz'),
    active_ms: req('bigint'),
    idle_ms: req('bigint'),
    end_reason: oneOf(req('text'), TIME_ENTRY_END_REASONS),
    source: oneOf(dflt('text'), TIME_ENTRY_SOURCES),
    project_id: opt('uuid'),
    task_id: opt('uuid'),
    local_revision: dflt('integer'),
    recorded_at: req('timestamptz'),
    created_at: dflt('timestamptz'),
  },
} as const satisfies Record<string, Record<string, ColumnSpec>>;

export type TableName = keyof typeof TABLE_COLUMNS;

// ---------------------------------------------------------------------------------------------
// Relationships (foreign keys), sorted by constraint name within each table
// ---------------------------------------------------------------------------------------------

export interface RelationshipSpec {
  readonly foreignKeyName: string;
  readonly columns: readonly string[];
  readonly isOneToOne: boolean;
  /** Table name without schema; `users` is `auth.users`. */
  readonly referencedRelation: string;
  readonly referencedColumns: readonly string[];
}

function fk<
  const N extends string,
  const C extends readonly string[],
  const O extends boolean,
  const R extends string,
  const RC extends readonly string[],
>(foreignKeyName: N, columns: C, referencedRelation: R, referencedColumns: RC, isOneToOne: O) {
  return { foreignKeyName, columns, isOneToOne, referencedRelation, referencedColumns } as const;
}

export const TABLE_RELATIONSHIPS = {
  profiles: [fk('profiles_id_fkey', ['id'], 'users', ['id'], true)],
  workspaces: [fk('workspaces_created_by_fkey', ['created_by'], 'users', ['id'], false)],
  workspace_members: [
    fk('workspace_members_user_id_fkey', ['user_id'], 'profiles', ['id'], false),
    fk('workspace_members_workspace_id_fkey', ['workspace_id'], 'workspaces', ['id'], false),
  ],
  workspace_invitations: [
    fk('workspace_invitations_accepted_by_fkey', ['accepted_by'], 'users', ['id'], false),
    fk('workspace_invitations_invited_by_fkey', ['invited_by'], 'users', ['id'], false),
    fk('workspace_invitations_workspace_id_fkey', ['workspace_id'], 'workspaces', ['id'], false),
  ],
  projects: [
    fk('projects_created_by_fkey', ['created_by'], 'users', ['id'], false),
    fk('projects_workspace_id_fkey', ['workspace_id'], 'workspaces', ['id'], false),
  ],
  tasks: [
    fk('tasks_assignee_id_fkey', ['assignee_id'], 'profiles', ['id'], false),
    fk('tasks_created_by_fkey', ['created_by'], 'users', ['id'], false),
    fk('tasks_project_id_workspace_id_fkey', ['project_id', 'workspace_id'], 'projects', ['id', 'workspace_id'], false),
    fk('tasks_workspace_id_fkey', ['workspace_id'], 'workspaces', ['id'], false),
  ],
  notes: [
    fk('notes_owner_id_fkey', ['owner_id'], 'profiles', ['id'], false),
    fk('notes_project_id_workspace_id_fkey', ['project_id', 'workspace_id'], 'projects', ['id', 'workspace_id'], false),
    fk('notes_workspace_id_fkey', ['workspace_id'], 'workspaces', ['id'], false),
  ],
  time_entries: [
    fk('time_entries_project_id_workspace_id_fkey', ['project_id', 'workspace_id'], 'projects', ['id', 'workspace_id'], false),
    fk('time_entries_task_id_workspace_id_fkey', ['task_id', 'workspace_id'], 'tasks', ['id', 'workspace_id'], false),
    fk('time_entries_user_id_fkey', ['user_id'], 'profiles', ['id'], false),
    fk('time_entries_workspace_id_fkey', ['workspace_id'], 'workspaces', ['id'], false),
  ],
} as const satisfies Record<TableName, readonly RelationshipSpec[]>;

// ---------------------------------------------------------------------------------------------
// Functions callable through the API (trigger functions excluded)
// ---------------------------------------------------------------------------------------------

export type ReturnSpec =
  | { readonly kind: 'void' }
  | { readonly kind: 'scalar'; readonly type: ColumnType }
  /** A single row of a table (`RETURNS public.<table>`). */
  | { readonly kind: 'row'; readonly table: TableName }
  /** `RETURNS TABLE (...)`: a set of records. */
  | { readonly kind: 'table'; readonly columns: Readonly<Record<string, ColumnSpec>> };

export interface FunctionSpec {
  /** Arguments in declaration order; `hasDefault` marks parameters with a default. */
  readonly args: Readonly<Record<string, ColumnSpec>>;
  readonly returns: ReturnSpec;
  /** SECURITY DEFINER (runs with the owner's rights; must check the caller itself). */
  readonly securityDefiner: boolean;
}

/** Every non-trigger function in `public`, with its argument names in declaration order. */
export const FUNCTIONS = {
  accept_invitation: {
    args: { p_token: req('text') },
    returns: { kind: 'scalar', type: 'uuid' },
    securityDefiner: true,
  },
  create_invitation: {
    args: { p_workspace_id: req('uuid'), p_email: req('text'), p_role: dflt('enum:workspace_role') },
    returns: {
      kind: 'table',
      columns: { invitation_id: req('uuid'), token: req('text'), expires_at: req('timestamptz') },
    },
    securityDefiner: true,
  },
  create_workspace: {
    args: { p_name: req('text') },
    returns: { kind: 'row', table: 'workspaces' },
    securityDefiner: true,
  },
  has_workspace_role: {
    args: { p_workspace_id: req('uuid'), p_roles: req('enum:workspace_role[]') },
    returns: { kind: 'scalar', type: 'boolean' },
    securityDefiner: true,
  },
  is_active_member: {
    args: { p_workspace_id: req('uuid'), p_user_id: req('uuid') },
    returns: { kind: 'scalar', type: 'boolean' },
    securityDefiner: true,
  },
  is_workspace_member: {
    args: { p_workspace_id: req('uuid') },
    returns: { kind: 'scalar', type: 'boolean' },
    securityDefiner: true,
  },
  my_workspaces: {
    args: {},
    returns: {
      kind: 'table',
      columns: {
        workspace_id: req('uuid'),
        name: req('text'),
        role: req('enum:workspace_role'),
        time_entry_visibility: req('enum:time_entry_visibility'),
        joined_at: req('timestamptz'),
      },
    },
    securityDefiner: true,
  },
  remove_member: {
    args: { p_workspace_id: req('uuid'), p_user_id: req('uuid') },
    returns: { kind: 'void' },
    securityDefiner: true,
  },
  revoke_invitation: {
    args: { p_invitation_id: req('uuid') },
    returns: { kind: 'void' },
    securityDefiner: true,
  },
  set_member_role: {
    args: { p_workspace_id: req('uuid'), p_user_id: req('uuid'), p_role: req('enum:workspace_role') },
    returns: { kind: 'void' },
    securityDefiner: true,
  },
  set_time_entry_visibility: {
    args: { p_workspace_id: req('uuid'), p_visibility: req('enum:time_entry_visibility') },
    returns: { kind: 'void' },
    securityDefiner: true,
  },
  shares_workspace_with: {
    args: { p_user_id: req('uuid') },
    returns: { kind: 'scalar', type: 'boolean' },
    securityDefiner: true,
  },
  sync_time_entries: {
    args: { p_workspace_id: req('uuid'), p_entries: req('jsonb') },
    returns: {
      kind: 'table',
      columns: {
        entry_id: opt('uuid'),
        status: oneOf(req('text'), SYNC_ENTRY_STATUSES),
        detail: opt('text'),
      },
    },
    // SECURITY INVOKER: every insert is checked by RLS as the calling user.
    securityDefiner: false,
  },
} as const satisfies Record<string, FunctionSpec>;

export type FunctionName = keyof typeof FUNCTIONS;

// ---------------------------------------------------------------------------------------------
// Compile-time cross-checks: this description ⇄ the `Database` type. A mismatch fails `tsc` with
// the offending table/function names in the error message.
// ---------------------------------------------------------------------------------------------

type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Simplify<T> = { [K in keyof T]: T[K] };
/** `T` must be `never`; otherwise the error message names what is in `T`. */
type ExpectNever<T extends never> = T;
type ExpectTrue<T extends true> = T;
type Failing<R> = { [K in keyof R]: R[K] extends true ? never : K }[keyof R];
type DeepMutable<T> = T extends readonly unknown[] | object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;

type Schema = Database['public'];

type TsBase<T> = T extends 'uuid' | 'text' | 'timestamptz' | 'date'
  ? string
  : T extends 'bigint' | 'integer'
    ? number
    : T extends 'boolean'
      ? boolean
      : T extends 'jsonb'
        ? Json
        : T extends `enum:${infer E extends EnumName}`
          ? Schema['Enums'][E]
          : never;
type TsType<T> = T extends `${infer B}[]` ? TsBase<B>[] : TsBase<T>;
type ValueOf<C> = C extends { readonly values: readonly (infer V)[] } ? V : C extends { readonly type: infer T } ? TsType<T> : never;
type Nullable<C> = C extends { readonly nullable: true } ? null : never;
type IsRequired<C> = C extends { readonly nullable: false; readonly hasDefault: false } ? true : false;

type RowOf<S> = { -readonly [K in keyof S]: ValueOf<S[K]> | Nullable<S[K]> };
type InsertOf<S> = Simplify<
  { -readonly [K in keyof S as IsRequired<S[K]> extends true ? K : never]: ValueOf<S[K]> | Nullable<S[K]> } & {
    -readonly [K in keyof S as IsRequired<S[K]> extends true ? never : K]?: ValueOf<S[K]> | Nullable<S[K]>;
  }
>;
type UpdateOf<S> = { -readonly [K in keyof S]?: ValueOf<S[K]> | Nullable<S[K]> };

type Columns = typeof TABLE_COLUMNS;

type _TableNames = ExpectTrue<Equals<keyof Schema['Tables'], TableName>>;
type _Rows = ExpectNever<Failing<{ [T in TableName]: Equals<Schema['Tables'][T]['Row'], RowOf<Columns[T]>> }>>;
type _Inserts = ExpectNever<Failing<{ [T in TableName]: Equals<Schema['Tables'][T]['Insert'], InsertOf<Columns[T]>> }>>;
type _Updates = ExpectNever<Failing<{ [T in TableName]: Equals<Schema['Tables'][T]['Update'], UpdateOf<Columns[T]>> }>>;
type _Relationships = ExpectNever<
  Failing<{
    [T in TableName]: Equals<Schema['Tables'][T]['Relationships'], DeepMutable<(typeof TABLE_RELATIONSHIPS)[T]>>;
  }>
>;
type _Enums = ExpectNever<
  Failing<{ [E in EnumName]: Equals<Schema['Enums'][E], (typeof Constants)['public']['Enums'][E][number]> }>
>;
type _EnumNames = ExpectTrue<Equals<EnumName, keyof (typeof Constants)['public']['Enums']>>;
type _EndReasons = ExpectTrue<Equals<TimeEntryEndReason, (typeof TIME_ENTRY_END_REASONS)[number]>>;

type Functions = typeof FUNCTIONS;
type ArgsOf<A> = keyof A extends never ? never : InsertOf<A>;
type ReturnsOf<R> = R extends { readonly kind: 'void' }
  ? undefined
  : R extends { readonly kind: 'scalar'; readonly type: infer T }
    ? TsType<T>
    : R extends { readonly kind: 'row'; readonly table: infer T extends TableName }
      ? Schema['Tables'][T]['Row']
      : R extends { readonly kind: 'table'; readonly columns: infer C }
        ? RowOf<C>[]
        : never;

type _FunctionNames = ExpectTrue<Equals<keyof Schema['Functions'], FunctionName>>;
type _FunctionArgs = ExpectNever<
  Failing<{ [F in FunctionName]: Equals<Schema['Functions'][F]['Args'], ArgsOf<Functions[F]['args']>> }>
>;
type _FunctionReturns = ExpectNever<
  Failing<{ [F in FunctionName]: Equals<Schema['Functions'][F]['Returns'], ReturnsOf<Functions[F]['returns']>> }>
>;

/** Referenced so `noUnusedLocals` keeps the assertions without exporting them. */
export type SchemaAssertions = [
  _TableNames,
  _Rows,
  _Inserts,
  _Updates,
  _Relationships,
  _Enums,
  _EnumNames,
  _EndReasons,
  _FunctionNames,
  _FunctionArgs,
  _FunctionReturns,
];
