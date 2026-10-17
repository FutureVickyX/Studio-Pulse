/**
 * Hand-written Postgres types for the Studio Pulse Supabase project.
 *
 * Source of truth: `supabase/migrations/*.sql`. The layout follows `supabase gen types typescript`
 * so the file can be regenerated later without changing callers, with three deliberate
 * refinements the generator cannot infer:
 *
 * - text columns constrained by `CHECK (col IN (...))` are typed as their literal union
 *   (`time_entries.kind`, `end_reason`, `source`);
 * - columns of `RETURNS TABLE` functions carry their real nullability and, where the function body
 *   fixes them, literal values (`sync_time_entries` → `entry_id`, `status`, `detail`);
 * - functions that only run as triggers are omitted (they cannot be called through the API).
 *
 * `Insert` / `Update` describe the table shape, exactly like generated types: the column-level
 * GRANTs in the migrations decide what the `authenticated` role may actually write, and RLS
 * decides which rows. `src/schema.ts` cross-checks every table, column, enum, relationship and
 * function here against a runtime description that `tests/unit/database/schema.test.ts` compares
 * with the migrations applied to a real Postgres (PGlite).
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          display_name?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      workspaces: {
        Row: {
          id: string;
          name: string;
          time_entry_visibility: Database['public']['Enums']['time_entry_visibility'];
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          time_entry_visibility?: Database['public']['Enums']['time_entry_visibility'];
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          time_entry_visibility?: Database['public']['Enums']['time_entry_visibility'];
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'workspaces_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      workspace_members: {
        Row: {
          workspace_id: string;
          user_id: string;
          role: Database['public']['Enums']['workspace_role'];
          status: Database['public']['Enums']['membership_status'];
          joined_at: string;
          updated_at: string;
        };
        Insert: {
          workspace_id: string;
          user_id: string;
          role?: Database['public']['Enums']['workspace_role'];
          status?: Database['public']['Enums']['membership_status'];
          joined_at?: string;
          updated_at?: string;
        };
        Update: {
          workspace_id?: string;
          user_id?: string;
          role?: Database['public']['Enums']['workspace_role'];
          status?: Database['public']['Enums']['membership_status'];
          joined_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'workspace_members_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'workspace_members_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      workspace_invitations: {
        Row: {
          id: string;
          workspace_id: string;
          email: string;
          role: Database['public']['Enums']['workspace_role'];
          token_hash: string;
          invited_by: string | null;
          expires_at: string;
          accepted_at: string | null;
          accepted_by: string | null;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          email: string;
          role?: Database['public']['Enums']['workspace_role'];
          token_hash: string;
          invited_by?: string | null;
          expires_at?: string;
          accepted_at?: string | null;
          accepted_by?: string | null;
          revoked_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          email?: string;
          role?: Database['public']['Enums']['workspace_role'];
          token_hash?: string;
          invited_by?: string | null;
          expires_at?: string;
          accepted_at?: string | null;
          accepted_by?: string | null;
          revoked_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'workspace_invitations_accepted_by_fkey';
            columns: ['accepted_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'workspace_invitations_invited_by_fkey';
            columns: ['invited_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'workspace_invitations_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      projects: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          description: string;
          status: Database['public']['Enums']['project_status'];
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          description?: string;
          status?: Database['public']['Enums']['project_status'];
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          description?: string;
          status?: Database['public']['Enums']['project_status'];
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'projects_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'projects_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      tasks: {
        Row: {
          id: string;
          workspace_id: string;
          project_id: string | null;
          title: string;
          description: string;
          status: Database['public']['Enums']['task_status'];
          priority: Database['public']['Enums']['task_priority'];
          assignee_id: string | null;
          created_by: string | null;
          due_date: string | null;
          start_date: string | null;
          estimated_minutes: number | null;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          project_id?: string | null;
          title: string;
          description?: string;
          status?: Database['public']['Enums']['task_status'];
          priority?: Database['public']['Enums']['task_priority'];
          assignee_id?: string | null;
          created_by?: string | null;
          due_date?: string | null;
          start_date?: string | null;
          estimated_minutes?: number | null;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          project_id?: string | null;
          title?: string;
          description?: string;
          status?: Database['public']['Enums']['task_status'];
          priority?: Database['public']['Enums']['task_priority'];
          assignee_id?: string | null;
          created_by?: string | null;
          due_date?: string | null;
          start_date?: string | null;
          estimated_minutes?: number | null;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tasks_assignee_id_fkey';
            columns: ['assignee_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'tasks_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'tasks_project_id_workspace_id_fkey';
            columns: ['project_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'tasks_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      notes: {
        Row: {
          id: string;
          workspace_id: string;
          owner_id: string;
          project_id: string | null;
          title: string;
          body: string;
          visibility: Database['public']['Enums']['note_visibility'];
          pinned: boolean;
          version: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          owner_id?: string;
          project_id?: string | null;
          title?: string;
          body?: string;
          visibility?: Database['public']['Enums']['note_visibility'];
          pinned?: boolean;
          version?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          owner_id?: string;
          project_id?: string | null;
          title?: string;
          body?: string;
          visibility?: Database['public']['Enums']['note_visibility'];
          pinned?: boolean;
          version?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'notes_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notes_project_id_workspace_id_fkey';
            columns: ['project_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'notes_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      time_entries: {
        Row: {
          id: string;
          workspace_id: string;
          user_id: string;
          device_id: string;
          application_id: string;
          application_name: string;
          kind: 'active' | 'idle';
          started_at: string;
          ended_at: string;
          active_ms: number;
          idle_ms: number;
          end_reason: TimeEntryEndReason;
          source: 'automatic';
          project_id: string | null;
          task_id: string | null;
          local_revision: number;
          recorded_at: string;
          created_at: string;
        };
        Insert: {
          id: string;
          workspace_id: string;
          user_id?: string;
          device_id: string;
          application_id: string;
          application_name: string;
          kind: 'active' | 'idle';
          started_at: string;
          ended_at: string;
          active_ms: number;
          idle_ms: number;
          end_reason: TimeEntryEndReason;
          source?: 'automatic';
          project_id?: string | null;
          task_id?: string | null;
          local_revision?: number;
          recorded_at: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          user_id?: string;
          device_id?: string;
          application_id?: string;
          application_name?: string;
          kind?: 'active' | 'idle';
          started_at?: string;
          ended_at?: string;
          active_ms?: number;
          idle_ms?: number;
          end_reason?: TimeEntryEndReason;
          source?: 'automatic';
          project_id?: string | null;
          task_id?: string | null;
          local_revision?: number;
          recorded_at?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'time_entries_project_id_workspace_id_fkey';
            columns: ['project_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'projects';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'time_entries_task_id_workspace_id_fkey';
            columns: ['task_id', 'workspace_id'];
            isOneToOne: false;
            referencedRelation: 'tasks';
            referencedColumns: ['id', 'workspace_id'];
          },
          {
            foreignKeyName: 'time_entries_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'time_entries_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      accept_invitation: {
        Args: { p_token: string };
        Returns: string;
      };
      create_invitation: {
        Args: {
          p_workspace_id: string;
          p_email: string;
          p_role?: Database['public']['Enums']['workspace_role'];
        };
        Returns: {
          invitation_id: string;
          token: string;
          expires_at: string;
        }[];
      };
      create_workspace: {
        Args: { p_name: string };
        Returns: {
          id: string;
          name: string;
          time_entry_visibility: Database['public']['Enums']['time_entry_visibility'];
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'workspaces';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      has_workspace_role: {
        Args: {
          p_workspace_id: string;
          p_roles: Database['public']['Enums']['workspace_role'][];
        };
        Returns: boolean;
      };
      is_active_member: {
        Args: { p_workspace_id: string; p_user_id: string };
        Returns: boolean;
      };
      is_workspace_member: {
        Args: { p_workspace_id: string };
        Returns: boolean;
      };
      my_workspaces: {
        Args: never;
        Returns: {
          workspace_id: string;
          name: string;
          role: Database['public']['Enums']['workspace_role'];
          time_entry_visibility: Database['public']['Enums']['time_entry_visibility'];
          joined_at: string;
        }[];
      };
      remove_member: {
        Args: { p_workspace_id: string; p_user_id: string };
        Returns: undefined;
      };
      revoke_invitation: {
        Args: { p_invitation_id: string };
        Returns: undefined;
      };
      set_member_role: {
        Args: {
          p_workspace_id: string;
          p_user_id: string;
          p_role: Database['public']['Enums']['workspace_role'];
        };
        Returns: undefined;
      };
      set_time_entry_visibility: {
        Args: {
          p_workspace_id: string;
          p_visibility: Database['public']['Enums']['time_entry_visibility'];
        };
        Returns: undefined;
      };
      shares_workspace_with: {
        Args: { p_user_id: string };
        Returns: boolean;
      };
      sync_time_entries: {
        /** `p_entries` is a JSON array of `SyncTimeEntryPayload` (at most 500 per call). */
        Args: { p_workspace_id: string; p_entries: Json };
        Returns: {
          /** Null only when the entry had no usable `id` (it is then `rejected`). */
          entry_id: string | null;
          status: 'synced' | 'rejected';
          /** `'already present'` for an idempotent retry, the SQL error for a rejection, else null. */
          detail: string | null;
        }[];
      };
    };
    Enums: {
      workspace_role: 'owner' | 'admin' | 'member';
      membership_status: 'active' | 'removed';
      time_entry_visibility: 'private' | 'admins';
      project_status: 'active' | 'archived';
      task_status: 'inbox' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'archived';
      task_priority: 'low' | 'normal' | 'high' | 'urgent';
      note_visibility: 'private' | 'workspace';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

/** `time_entries.end_reason`: why the desktop closed the interval (docs/architecture.md §4). */
export type TimeEntryEndReason =
  | 'appSwitch'
  | 'becameIdle'
  | 'inputResumed'
  | 'untracked'
  | 'sessionAway'
  | 'paused'
  | 'disabled'
  | 'timeGap'
  | 'clockChange'
  | 'shutdown'
  | 'recovered'
  | 'settingsChanged';

type PublicSchema = Database['public'];

/** Row type of a table: `Tables<'tasks'>`. */
export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];
/** Insert type of a table: `TablesInsert<'tasks'>`. */
export type TablesInsert<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Insert'];
/** Update type of a table: `TablesUpdate<'tasks'>`. */
export type TablesUpdate<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Update'];
/** A Postgres enum: `Enums<'workspace_role'>`. */
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T];
/** Arguments of an RPC: `FunctionArgs<'create_workspace'>`. */
export type FunctionArgs<T extends keyof PublicSchema['Functions']> = PublicSchema['Functions'][T]['Args'];
/** Result of an RPC: `FunctionReturns<'my_workspaces'>`. */
export type FunctionReturns<T extends keyof PublicSchema['Functions']> = PublicSchema['Functions'][T]['Returns'];
