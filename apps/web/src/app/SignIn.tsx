/** Email + password with Supabase Auth: the same accounts as the desktop app. */

import { useState } from 'react';
import type { FormEvent } from 'react';
import type { StudioPulseClient } from '@studio-pulse/database';
import { Banner, BrandMark, Button, Field, SegmentedControl, TextInput } from '@studio-pulse/ui';

import { asProblem } from '../lib/errors';
import type { Problem } from '../lib/errors';
import { validateEmail, validateName } from '../lib/model';

type Mode = 'signIn' | 'signUp';

export function SignIn({ client }: { client: StudioPulseClient }) {
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);
  const [touched, setTouched] = useState(false);

  const emailError = touched ? validateEmail(email) : null;
  const passwordError = touched && mode === 'signUp' && password.length < 8 ? 'Use at least 8 characters.' : null;
  const nameError = touched && mode === 'signUp' ? validateName(name, 'Your name', 80) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (validateEmail(email) || (mode === 'signUp' && (password.length < 8 || validateName(name, 'Name', 80))) || !password) return;
    setPending(true);
    setProblem(null);
    try {
      if (mode === 'signIn') {
        const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (error) setProblem(asProblem(error));
      } else {
        const { data, error } = await client.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { display_name: name.trim() },
            // The confirmation link leads back to this address when it is in the project's Redirect
            // URLs (otherwise to the Site URL). The origin only: the session arrives as a #fragment,
            // which a #/route in the address would break.
            emailRedirectTo: window.location.origin,
          },
        });
        if (error) setProblem(asProblem(error));
        else if (!data.session) setCheckEmail(true);
      }
    } catch (error) {
      setProblem(asProblem(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="web-outside">
      <div className="web-auth">
        <div className="web-auth__brand">
          <BrandMark size={28} />
          <span>Studio Pulse</span>
        </div>
        <h1 className="web-auth__title">{mode === 'signIn' ? 'Sign in to your workspace' : 'Create your account'}</h1>
        <p className="web-auth__lead">Projects, tasks and notes for your studio. Use the same account as the Studio Pulse desktop app.</p>

        <SegmentedControl<Mode>
          aria-label="Sign in or create an account"
          value={mode}
          onChange={(next) => {
            setMode(next);
            setProblem(null);
            setTouched(false);
            setCheckEmail(false);
          }}
          options={[
            { value: 'signIn', label: 'Sign in' },
            { value: 'signUp', label: 'Create account' },
          ]}
        />

        {checkEmail ? (
          <Banner tone="success" title="Check your inbox">
            We sent a confirmation link to {email.trim()}. Open it, then sign in here.
          </Banner>
        ) : null}
        {problem ? <Banner tone={problem.kind === 'network' ? 'warning' : 'danger'}>{problem.message}</Banner> : null}

        <form className="web-auth__form" onSubmit={(event) => void submit(event)} noValidate>
          {mode === 'signUp' ? (
            <Field label="Your name" htmlFor="auth-name" error={nameError}>
              <TextInput id="auth-name" autoComplete="name" value={name} invalid={Boolean(nameError)} onChange={(e) => setName(e.currentTarget.value)} />
            </Field>
          ) : null}
          <Field label="Email" htmlFor="auth-email" error={emailError}>
            <TextInput
              id="auth-email"
              type="email"
              autoComplete="email"
              value={email}
              invalid={Boolean(emailError)}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
          </Field>
          <Field label="Password" htmlFor="auth-password" error={passwordError} hint={mode === 'signUp' ? 'At least 8 characters.' : undefined}>
            <TextInput
              id="auth-password"
              type="password"
              autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
              value={password}
              invalid={Boolean(passwordError)}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
          </Field>
          <Button type="submit" variant="primary" pending={pending}>
            {mode === 'signIn' ? 'Sign in' : 'Create account'}
          </Button>
        </form>
      </div>
    </main>
  );
}
