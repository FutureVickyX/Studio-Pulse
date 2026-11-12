/**
 * Signed in, but in no workspace yet: create one, or join with an invitation code. Same layout as
 * the sign-in page (tabs above the card).
 */

import { useState } from 'react';
import type { FormEvent } from 'react';
import type { StudioPulseClient } from '@studio-pulse/database';
import { BrandMark, Button, TextInput } from '@studio-pulse/ui';

import * as api from '../lib/api';
import { validateName } from '../lib/model';
import { useAction } from '../components/common';
import { AuthLayout } from './AuthLayout';

type Mode = 'create' | 'join';

export function Onboarding({
  client,
  email,
  onJoined,
}: {
  client: StudioPulseClient;
  email: string | null;
  onJoined: (workspaceId: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>('create');
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
    <AuthLayout>
      <div className="web-entry">
        <div className="web-entry__tabs" role="group" aria-label="Create or join a workspace">
          <button type="button" className="web-entry__tab" aria-pressed={mode === 'create'} onClick={() => setMode('create')}>
            Create workspace
          </button>
          <button type="button" className="web-entry__tab" aria-pressed={mode === 'join'} onClick={() => setMode('join')}>
            Join workspace
          </button>
        </div>

        <section className="web-entry__card" aria-labelledby="onboarding-title">
          <div className="web-entry__top" />
          <div className="web-entry__body">
            <BrandMark size={77.2158} title="Studio Pulse" />
            <h1 id="onboarding-title" className="web-entry__title">
              Set up your workspace
            </h1>
            <p className="web-entry__lead">
              You’re signed in{email ? ` as ${email}` : ''}, but not a member of a workspace yet.{' '}
              {mode === 'create'
                ? 'Create one for your studio: you become its owner and can invite your team.'
                : 'Join your team with the invitation code you were sent. It works for the email address it was sent to.'}
            </p>

            <div className="web-entry__content">
              {mode === 'create' ? (
                <form className="web-entry__form" onSubmit={(e) => void submitCreate(e)} noValidate>
                  <div className="web-entry__field">
                    <label htmlFor="ws-name" className="sp-visually-hidden">
                      Workspace name
                    </label>
                    <TextInput
                      id="ws-name"
                      inputSize="lg"
                      placeholder="Workspace name"
                      value={name}
                      invalid={Boolean(nameError)}
                      aria-describedby={nameError ? 'ws-name-error' : undefined}
                      onChange={(e) => setName(e.currentTarget.value)}
                    />
                    {nameError ? (
                      <p id="ws-name-error" className="web-entry__error">
                        {nameError}
                      </p>
                    ) : null}
                  </div>
                  <Button type="submit" variant="primary" size="lg" pending={create.pending} className="web-entry__submit">
                    Create workspace
                  </Button>
                </form>
              ) : (
                <form className="web-entry__form" onSubmit={(e) => void submitJoin(e)} noValidate>
                  <div className="web-entry__field">
                    <label htmlFor="ws-token" className="sp-visually-hidden">
                      Invitation code
                    </label>
                    <TextInput
                      id="ws-token"
                      inputSize="lg"
                      mono
                      placeholder="Invitation code"
                      value={token}
                      autoComplete="off"
                      onChange={(e) => setToken(e.currentTarget.value)}
                    />
                  </div>
                  <Button type="submit" variant="primary" size="lg" pending={join.pending} disabled={!token.trim()} className="web-entry__submit">
                    Join workspace
                  </Button>
                </form>
              )}
            </div>

            <button type="button" className="web-entry__link" onClick={() => void client.auth.signOut({ scope: 'local' })}>
              Sign out
            </button>
          </div>
        </section>
      </div>
    </AuthLayout>
  );
}
