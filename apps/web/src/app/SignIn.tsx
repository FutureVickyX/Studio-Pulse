/**
 * Email + password with Supabase Auth: the same accounts as the desktop app. Laid out as the Figma
 * "Sign in" / "Create account" frames: two tabs above a card with the logo, one heading and the
 * fields. The fields' visible labels are their placeholders, as designed; each also has a real
 * (visually hidden) label.
 */

import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { StudioPulseClient } from '@studio-pulse/database';
import { Banner, BrandMark, Button, TextInput } from '@studio-pulse/ui';

import arrowBackUrl from '../assets/arrow-back.svg';
import { asProblem } from '../lib/errors';
import type { Problem } from '../lib/errors';
import { validateEmail, validateName } from '../lib/model';
import { AuthLayout } from './AuthLayout';

type Mode = 'signIn' | 'signUp';

/** The Figma logo's height in the card (113.985 × 77.2158). */
const LOGO_HEIGHT = 77.2158;

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
  const passwordError = touched
    ? mode === 'signUp' && password.length < 8
      ? 'Use at least 8 characters.'
      : !password
        ? 'Enter your password.'
        : null
    : null;
  const nameError = touched && mode === 'signUp' ? validateName(name, 'Your name', 80) : null;

  function switchTo(next: Mode) {
    setMode(next);
    setProblem(null);
    setTouched(false);
    setCheckEmail(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    // Rendered now, so the errors are linked (aria-describedby) before focus moves.
    flushSync(() => setTouched(true));
    // The first invalid field, in the order they appear, takes focus so its error is announced.
    const invalid =
      mode === 'signUp' && validateName(name, 'Name', 80)
        ? 'auth-name'
        : validateEmail(email)
          ? 'auth-email'
          : (mode === 'signUp' && password.length < 8) || !password
            ? 'auth-password'
            : null;
    if (invalid) {
      document.getElementById(invalid)?.focus();
      return;
    }
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
    <AuthLayout>
      <div className="web-entry">
        <div className="web-entry__tabs" role="group" aria-label="Sign in or create an account">
          <button type="button" className="web-entry__tab" aria-pressed={mode === 'signIn'} onClick={() => switchTo('signIn')}>
            Sign in
          </button>
          <button type="button" className="web-entry__tab" aria-pressed={mode === 'signUp'} onClick={() => switchTo('signUp')}>
            Create account
          </button>
        </div>

        <section className="web-entry__card" aria-labelledby="entry-title">
          <div className="web-entry__top">
            {/* Back leads from Create account to Sign in; Sign in is the first page, so its slot stays empty. */}
            {mode === 'signUp' ? (
              <button type="button" className="web-entry__back" aria-label="Back to sign in" onClick={() => switchTo('signIn')}>
                <img src={arrowBackUrl} alt="" width={7.00111} height={9.00111} />
              </button>
            ) : null}
          </div>

          <div className="web-entry__body">
            <BrandMark size={LOGO_HEIGHT} title="Studio Pulse" />
            <h1 id="entry-title" className="web-entry__title">
              Login or Sign Up
            </h1>

            <div className="web-entry__content">
              {checkEmail ? (
                <Banner tone="success" title="Check your inbox">
                  We sent a confirmation link to {email.trim()}. Open it, then sign in here.
                </Banner>
              ) : null}
              {problem ? <Banner tone={problem.kind === 'network' ? 'warning' : 'danger'}>{problem.message}</Banner> : null}

              <form className="web-entry__form" onSubmit={(event) => void submit(event)} noValidate>
                {mode === 'signUp' ? (
                  <EntryField id="auth-name" label="Name" error={nameError}>
                    <TextInput
                      id="auth-name"
                      inputSize="lg"
                      autoComplete="name"
                      placeholder="Name"
                      value={name}
                      invalid={Boolean(nameError)}
                      aria-describedby={nameError ? 'auth-name-error' : undefined}
                      onChange={(e) => setName(e.currentTarget.value)}
                    />
                  </EntryField>
                ) : null}
                <EntryField id="auth-email" label="Email" error={emailError}>
                  <TextInput
                    id="auth-email"
                    inputSize="lg"
                    type="email"
                    autoComplete="email"
                    placeholder="your@email.com"
                    value={email}
                    invalid={Boolean(emailError)}
                    aria-describedby={emailError ? 'auth-email-error' : undefined}
                    onChange={(e) => setEmail(e.currentTarget.value)}
                  />
                </EntryField>
                <EntryField id="auth-password" label={mode === 'signUp' ? 'Password (at least 8 characters)' : 'Password'} error={passwordError}>
                  <TextInput
                    id="auth-password"
                    inputSize="lg"
                    type="password"
                    autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
                    placeholder="Password"
                    value={password}
                    invalid={Boolean(passwordError)}
                    aria-describedby={passwordError ? 'auth-password-error' : undefined}
                    onChange={(e) => setPassword(e.currentTarget.value)}
                  />
                </EntryField>
                <Button type="submit" variant="primary" size="lg" pending={pending} className="web-entry__submit">
                  Submit
                </Button>
              </form>
            </div>
          </div>
        </section>
      </div>
    </AuthLayout>
  );
}

/** A field whose visible label is its placeholder; the label is still there for assistive tech. */
function EntryField({ id, label, error, children }: { id: string; label: string; error: string | null; children: ReactNode }) {
  return (
    <div className="web-entry__field">
      <label htmlFor={id} className="sp-visually-hidden">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="web-entry__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
