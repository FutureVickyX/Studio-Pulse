/**
 * Gates, in order: a configured build → a Supabase session → a workspace membership → the
 * workspace. Nothing here holds data of its own: every screen reads the user's RLS-checked rows.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { StudioPulseClient } from '@studio-pulse/database';
import { Banner, BrandMark, SkeletonLines } from '@studio-pulse/ui';

import * as api from '../lib/api';
import type { WorkspaceInfo } from '../lib/model';
import { useNavigation } from '../lib/router';
import { clearQueries, useQuery } from '../lib/store';
import { setUpClient } from '../lib/supabase';
import { ProblemBanner } from '../components/common';
import { Notices } from '../components/notices';
import { AuthLayout } from './AuthLayout';
import { Onboarding } from './Onboarding';
import { Shell } from './Shell';
import { SignIn } from './SignIn';
import { WorkspaceContext, useMembersQuery } from './workspace';
import type { WorkspaceContextValue } from './workspace';

// Only these two fields: Vite inlines a bare `import.meta.env` as an object literal holding every
// VITE_* value it loaded, read by the app or not.
const setup = setUpClient({
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
});

export function App() {
  return (
    <>
      {setup.ok ? <SessionGate client={setup.client} /> : <NotConfigured reason={setup.reason} />}
      <Notices />
    </>
  );
}

function NotConfigured({ reason }: { reason: string }) {
  return (
    <AuthLayout>
      <OutsideCard title="Studio Pulse workspace">
        <Banner tone="warning" title="Not connected to Supabase">
          {reason} See apps/web/README.md.
        </Banner>
      </OutsideCard>
    </AuthLayout>
  );
}

/** The sign-in card's frame (logo, heading) around a message, for the other outside screens. */
function OutsideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="web-entry">
      <section className="web-entry__card" aria-label={title}>
        <div className="web-entry__top" />
        <div className="web-entry__body">
          <BrandMark size={77.2158} title="Studio Pulse" />
          <h1 className="web-entry__title">{title}</h1>
          <div className="web-entry__content">{children}</div>
        </div>
      </section>
    </div>
  );
}

type SessionState = { status: 'loading' } | { status: 'signedOut' } | { status: 'signedIn'; session: Session };

function SessionGate({ client }: { client: StudioPulseClient }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    void client.auth.getSession().then(({ data }) => {
      if (active) setState(data.session ? { status: 'signedIn', session: data.session } : { status: 'signedOut' });
    });
    // Called on sign-in, sign-out, token refresh and when a refresh finally fails (expiry).
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') clearQueries();
      setState(session ? { status: 'signedIn', session } : { status: 'signedOut' });
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  if (state.status === 'loading') return <Boot />;
  if (state.status === 'signedOut') return <SignIn client={client} />;
  return <WorkspaceGate client={client} session={state.session} />;
}

function Boot() {
  return (
    <AuthLayout>
      <OutsideCard title="Loading your workspace">
        <SkeletonLines lines={2} label="Loading your workspace" />
      </OutsideCard>
    </AuthLayout>
  );
}

const SELECTED_KEY = 'studio-pulse:workspace:';

function readSelected(userId: string): string | null {
  try {
    return window.localStorage.getItem(`${SELECTED_KEY}${userId}`);
  } catch {
    return null;
  }
}

function writeSelected(userId: string, workspaceId: string): void {
  try {
    window.localStorage.setItem(`${SELECTED_KEY}${userId}`, workspaceId);
  } catch {
    // Private mode: the choice lasts for this tab only.
  }
}

function WorkspaceGate({ client, session }: { client: StudioPulseClient; session: Session }) {
  const userId = session.user.id;
  const workspaces = useQuery(`user:${userId}:workspaces`, () => api.listMyWorkspaces(client));
  const profile = useQuery(`user:${userId}:profile`, () => api.listProfiles(client, [userId]));
  const [selected, setSelected] = useState<string | null>(() => readSelected(userId));
  const nav = useNavigation();

  const list = workspaces.data ?? [];
  const workspace: WorkspaceInfo | undefined = list.find((w) => w.id === selected) ?? list[0];
  const members = useMembersQuery(client, workspace?.id ?? null);

  const user = useMemo(
    () => ({
      id: userId,
      email: session.user.email ?? null,
      displayName:
        profile.data?.get(userId) ??
        (typeof session.user.user_metadata?.display_name === 'string' ? session.user.user_metadata.display_name : null) ??
        session.user.email ??
        'You',
    }),
    [userId, session.user.email, session.user.user_metadata, profile.data],
  );

  const value = useMemo<WorkspaceContextValue | null>(() => {
    if (!workspace) return null;
    const names = new Map((members.data ?? []).map((m) => [m.userId, m.displayName]));
    return {
      client,
      user,
      workspace,
      workspaces: list,
      members: members.data ?? [],
      nav,
      memberName: (id) => (id ? (id === userId ? user.displayName : (names.get(id) ?? 'Former member')) : 'Unassigned'),
      selectWorkspace: (id) => {
        writeSelected(userId, id);
        setSelected(id);
        nav.navigate({ name: 'overview' });
      },
      reloadWorkspaces: workspaces.reload,
      signOut: async () => {
        await client.auth.signOut({ scope: 'local' });
      },
    };
  }, [client, user, workspace, list, members.data, nav, userId, workspaces.reload]);

  if (workspaces.data === undefined) {
    if (workspaces.problem) {
      return (
        <AuthLayout>
          <OutsideCard title="Studio Pulse workspace">
            <ProblemBanner problem={workspaces.problem} onRetry={() => void workspaces.reload()} title="Couldn’t load your workspaces" />
          </OutsideCard>
        </AuthLayout>
      );
    }
    return <Boot />;
  }
  if (!value) {
    return (
      <Onboarding
        client={client}
        email={user.email}
        onJoined={async (id) => {
          writeSelected(userId, id);
          setSelected(id);
          await workspaces.reload();
        }}
      />
    );
  }
  return (
    <WorkspaceContext.Provider value={value}>
      <Shell key={`${userId}:${value.workspace.id}`} membersProblem={members.problem} onRetryMembers={() => void members.reload()} />
    </WorkspaceContext.Provider>
  );
}
