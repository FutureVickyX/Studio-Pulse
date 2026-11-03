/** Signed in, but in no workspace yet: create one, or join with an invitation code. */

import { useState } from 'react';
import type { FormEvent } from 'react';
import type { StudioPulseClient } from '@studio-pulse/database';
import { BrandMark, Button, Card, Field, TextInput } from '@studio-pulse/ui';

import * as api from '../lib/api';
import { validateName } from '../lib/model';
import { useAction } from '../components/common';

export function Onboarding({
  client,
  email,
  onJoined,
}: {
  client: StudioPulseClient;
  email: string | null;
  onJoined: (workspaceId: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const create = useAction();
  const join = useAction();
  const nameError = nameTouched ? validateName(name, 'The workspace name', 80) : null;

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    setNameTouched(true);
    if (validateName(name, 'Name', 80)) return;
    const id = await create.run(() => api.createWorkspace(client, name), 'Workspace created.');
    if (id) await onJoined(id);
  }

  async function submitJoin(event: FormEvent) {
    event.preventDefault();
    if (!token.trim()) return;
    const id = await join.run(() => api.acceptInvitation(client, token), 'You joined the workspace.');
    if (id) await onJoined(id);
  }

  return (
    <main className="web-outside web-outside--top">
      <div className="web-onboarding">
        <div className="web-auth__brand">
          <BrandMark size={28} />
          <span>Studio Pulse</span>
        </div>
        <h1 className="web-auth__title">Set up your workspace</h1>
        <p className="web-auth__lead">
          You’re signed in{email ? ` as ${email}` : ''}, but not a member of a workspace yet. Create one for your studio, or join your team with
          the invitation code you were sent.
        </p>
        <div className="web-onboarding__grid">
          <Card title="Create a workspace" description="You become its owner and can invite your team.">
            <form className="web-form" onSubmit={(e) => void submitCreate(e)} noValidate>
              <Field label="Workspace name" htmlFor="ws-name" error={nameError}>
                <TextInput id="ws-name" value={name} invalid={Boolean(nameError)} onChange={(e) => setName(e.currentTarget.value)} />
              </Field>
              <Button type="submit" variant="primary" pending={create.pending}>
                Create workspace
              </Button>
            </form>
          </Card>
          <Card title="Join with an invitation" description="Invitations work for the email address they were sent to.">
            <form className="web-form" onSubmit={(e) => void submitJoin(e)} noValidate>
              <Field label="Invitation code" htmlFor="ws-token">
                <TextInput id="ws-token" mono value={token} autoComplete="off" onChange={(e) => setToken(e.currentTarget.value)} />
              </Field>
              <Button type="submit" pending={join.pending} disabled={!token.trim()}>
                Join workspace
              </Button>
            </form>
          </Card>
        </div>
        <p className="web-footnote">
          <button type="button" className="web-link" onClick={() => void client.auth.signOut({ scope: 'local' })}>
            Sign out
          </button>
        </p>
      </div>
    </main>
  );
}
