import { useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode, RefObject } from 'react';
import type { SignInInput, SignUpInput } from '@studio-pulse/shared-types';
import { Banner, Button, Card, Dialog, Field, IconButton, IconEye, IconEyeOff, IconSignOut, TextInput } from '@studio-pulse/ui';
import { InlineError } from '../../components/common';
import { storeAccount, useCommandAction } from '../../hooks/useCloud';
import {
  displayNameError,
  emailError,
  NAME_MAX_LENGTH,
  normalizeEmail,
  normalizeName,
  PASSWORD_MIN_LENGTH,
  passwordError,
} from '../../lib/account';
import { call } from '../../lib/api';

// ---------------------------------------------------------------------------------------------
// Password field with show / hide
// ---------------------------------------------------------------------------------------------

function PasswordField({
  id,
  label,
  value,
  onChange,
  visible,
  onToggleVisible,
  autoComplete,
  error,
  hint,
  readOnly,
  inputRef,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggleVisible: () => void;
  autoComplete: 'current-password' | 'new-password';
  error: string | null;
  hint?: ReactNode;
  readOnly: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const errorId = `${id}-error`;
  return (
    <Field label={label} htmlFor={id} error={error ?? undefined} errorId={errorId} hint={hint}>
      <span className="app-password">
        <TextInput
          ref={inputRef}
          id={id}
          name="password"
          type={visible ? 'text' : 'password'}
          value={value}
          autoComplete={autoComplete}
          autoCapitalize="off"
          spellCheck={false}
          readOnly={readOnly}
          invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          className="app-password__input"
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        {/* A toggle button: the accessible name stays constant and `aria-pressed` carries the state. */}
        <IconButton
          size="sm"
          label="Show password"
          title={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          aria-controls={id}
          icon={visible ? <IconEyeOff size={14} /> : <IconEye size={14} />}
          onClick={onToggleVisible}
        />
      </span>
    </Field>
  );
}

// ---------------------------------------------------------------------------------------------
// Sign in / create an account
// ---------------------------------------------------------------------------------------------

type AuthMode = 'signIn' | 'signUp';

/**
 * Email + password sign-in, with an optional switch to account creation. The password is held in
 * state only while it is being typed: it is cleared the moment the form is sent, whatever the
 * outcome, and is never logged.
 */
export function AuthCard({
  title,
  description,
  initialEmail = '',
  allowSignUp = true,
}: {
  title?: string;
  description?: ReactNode;
  initialEmail?: string;
  allowSignUp?: boolean;
}) {
  const [mode, setMode] = useState<AuthMode>('signIn');
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const base = useId();
  const ids = { email: `${base}-email`, password: `${base}-password`, name: `${base}-name` };

  const signIn = useCommandAction((input: SignInInput) => call('sign_in', { input }));
  const signUp = useCommandAction((input: SignUpInput) => call('sign_up', { input }));
  const pending = signIn.pending || signUp.pending;
  const serverError = mode === 'signIn' ? signIn.error : signUp.error;
  const signingUp = allowSignUp && mode === 'signUp';

  const errors = {
    email: emailError(email),
    password: passwordError(password, signingUp ? 'signUp' : 'signIn'),
    name: signingUp ? displayNameError(displayName) : null,
  };

  function switchMode(next: AuthMode) {
    setMode(next);
    setShowErrors(false);
    setNotice(null);
    setPassword('');
    setPasswordVisible(false);
    signIn.clearError();
    signUp.clearError();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setNotice(null);
    if (errors.email || errors.name || errors.password) {
      setShowErrors(true);
      (errors.email ? emailRef : errors.name ? nameRef : passwordRef).current?.focus();
      return;
    }
    // From here on the password exists only in this call's arguments.
    const secret = password;
    setPassword('');
    setPasswordVisible(false);
    setShowErrors(false);
    if (signingUp) {
      const result = await signUp.run({ email: normalizeEmail(email), password: secret, displayName: normalizeName(displayName) });
      if (!result) {
        passwordRef.current?.focus();
        return;
      }
      storeAccount(result.account);
      if (result.status === 'confirmationRequired') {
        setMode('signIn');
        signIn.clearError();
        setNotice('Check your email to confirm your address, then sign in here.');
        passwordRef.current?.focus();
      }
      return;
    }
    const result = await signIn.run({ email: normalizeEmail(email), password: secret });
    if (result) storeAccount(result);
    else passwordRef.current?.focus();
  }

  // `title` names the sign-in form; account creation always says what it is.
  const heading = signingUp ? 'Create an account' : (title ?? 'Sign in');
  return (
    <Card title={heading} description={description}>
      {notice ? (
        <Banner tone="success" compact className="app-auth__notice">
          {notice}
        </Banner>
      ) : null}
      <form className="app-auth" onSubmit={(event) => void submit(event)} noValidate aria-busy={pending || undefined}>
        <Field label="Email" htmlFor={ids.email} error={showErrors ? errors.email ?? undefined : undefined} errorId={`${ids.email}-error`}>
          <TextInput
            ref={emailRef}
            id={ids.email}
            name="email"
            type="email"
            value={email}
            autoComplete="email"
            autoCapitalize="off"
            spellCheck={false}
            readOnly={pending}
            invalid={showErrors && errors.email !== null}
            aria-describedby={showErrors && errors.email ? `${ids.email}-error` : undefined}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
        </Field>
        {signingUp ? (
          <Field
            label="Your name"
            htmlFor={ids.name}
            hint="Shown to people in your workspaces."
            error={showErrors ? errors.name ?? undefined : undefined}
            errorId={`${ids.name}-error`}
          >
            <TextInput
              ref={nameRef}
              id={ids.name}
              name="name"
              value={displayName}
              autoComplete="name"
              maxLength={NAME_MAX_LENGTH * 2}
              readOnly={pending}
              invalid={showErrors && errors.name !== null}
              aria-describedby={showErrors && errors.name ? `${ids.name}-error` : undefined}
              onChange={(event) => setDisplayName(event.currentTarget.value)}
            />
          </Field>
        ) : null}
        <PasswordField
          id={ids.password}
          label="Password"
          value={password}
          onChange={setPassword}
          visible={passwordVisible}
          onToggleVisible={() => setPasswordVisible((value) => !value)}
          autoComplete={signingUp ? 'new-password' : 'current-password'}
          error={showErrors ? errors.password : null}
          hint={signingUp ? `At least ${PASSWORD_MIN_LENGTH} characters.` : undefined}
          readOnly={pending}
          inputRef={passwordRef}
        />
        <InlineError error={serverError} />
        <div className="app-auth__actions">
          <Button type="submit" variant="primary" pending={pending}>
            {signingUp ? 'Create account' : 'Sign in'}
          </Button>
          {allowSignUp ? (
            <span className="app-auth__switch">
              {signingUp ? 'Already have an account?' : 'New to Studio Pulse?'}{' '}
              <button
                type="button"
                className="app-link"
                disabled={pending}
                onClick={() => switchMode(signingUp ? 'signIn' : 'signUp')}
              >
                {signingUp ? 'Sign in' : 'Create an account'}
              </button>
            </span>
          ) : null}
        </div>
        <p className="app-footnote">
          Studio Pulse never stores your password. It keeps only a sign-in session, in Windows Credential Manager.
        </p>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Sign out (always confirmed)
// ---------------------------------------------------------------------------------------------

export function SignOutButton({ label = 'Sign out', variant = 'secondary' }: { label?: string; variant?: 'secondary' | 'ghost' }) {
  const [open, setOpen] = useState(false);
  const signOut = useCommandAction(() => call('sign_out'));

  async function confirm() {
    const result = await signOut.run();
    if (!result) return;
    setOpen(false);
    storeAccount(result);
  }

  return (
    <>
      <Button
        size="sm"
        variant={variant}
        icon={<IconSignOut size={14} />}
        onClick={() => {
          signOut.clearError();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        dismissible={!signOut.pending}
        title="Sign out on this device?"
        description="Your tracking history stays on this device, and tracking carries on as before."
        footerStart={<InlineError error={signOut.error} />}
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={signOut.pending}>
              Cancel
            </Button>
            <Button variant="primary" icon={<IconSignOut size={14} />} pending={signOut.pending} onClick={() => void confirm()}>
              Sign out
            </Button>
          </>
        }
      >
        <p className="app-dialog-text">
          Intervals that haven’t uploaded yet stay here and upload the next time you sign in with this account.
        </p>
        <p className="app-dialog-text">
          While you’re signed out, new intervals are kept on this device only. Nothing is deleted locally or in your
          workspaces.
        </p>
      </Dialog>
    </>
  );
}
