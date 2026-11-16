/**
 * Errors from Supabase (PostgREST, Postgres, Auth) or the network, turned into one shape the UI
 * shows. Messages raised by the Studio Pulse functions and triggers are written for people and
 * are passed through; raw database wording (constraint names, SQL) never is.
 */

export type ProblemKind =
  | 'network'
  | 'session'
  | 'permission'
  | 'conflict'
  | 'duplicate'
  | 'invalid'
  | 'notFound'
  | 'blocked'
  | 'rateLimited'
  | 'unknown';

export interface Problem {
  readonly kind: ProblemKind;
  readonly message: string;
  /** SQLSTATE / PostgREST / Auth code when there is one. */
  readonly code?: string | undefined;
}

interface Coded {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  name?: unknown;
}

const NETWORK =
  'Can’t reach Supabase right now. Check your connection and try again; nothing you typed was lost.';
const SESSION = 'Your session has ended. Sign in again to continue.';
const PERMISSION = 'You don’t have permission to do that in this workspace.';

/** Messages our own SQL raises (RAISE ... USING ERRCODE) are sentences; Postgres' are not. */
function isOwnMessage(message: string): boolean {
  return (
    message.length > 0 &&
    message.length <= 200 &&
    !/violates|constraint|relation |column |permission denied|row-level security|syntax|null value|duplicate key|invalid input/i.test(message)
  );
}

function sentence(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length === 0) return trimmed;
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true; // fetch() rejected: offline, DNS, CORS, aborted
  if (typeof error === 'object' && error !== null) {
    const { name, message, status } = error as Coded;
    if (name === 'AuthRetryableFetchError') return true;
    if (status === 0) return true;
    if (typeof message === 'string' && /failed to fetch|network ?error|load failed|fetch failed/i.test(message)) return true;
  }
  return false;
}

export function toProblem(error: unknown): Problem {
  if (isNetworkError(error)) return { kind: 'network', message: NETWORK };
  if (typeof error !== 'object' || error === null) return { kind: 'unknown', message: 'Something went wrong.' };
  const { code: rawCode, message: rawMessage, status } = error as Coded;
  const code = typeof rawCode === 'string' ? rawCode : undefined;
  const message = typeof rawMessage === 'string' ? rawMessage : '';

  if (status === 429 || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') {
    return { kind: 'rateLimited', message: 'Too many requests. Wait a moment and try again.', code };
  }
  switch (code) {
    // Auth (supabase-js AuthApiError codes)
    case 'invalid_credentials':
      return { kind: 'session', message: 'That email and password don’t match an account.', code };
    case 'email_not_confirmed':
      return { kind: 'session', message: 'Confirm your email address first: open the link Supabase sent you.', code };
    case 'user_already_exists':
    case 'email_exists':
      return { kind: 'duplicate', message: 'An account with that email already exists. Sign in instead.', code };
    case 'weak_password':
      return { kind: 'invalid', message: 'Choose a longer password (at least 8 characters).', code };
    case 'session_not_found':
    case 'refresh_token_not_found':
    case 'bad_jwt':
    case 'PGRST301':
    case 'PGRST302':
    case 'PGRST303':
      return { kind: 'session', message: SESSION, code };
    // Postgres / PostgREST
    case '28000':
      return { kind: 'session', message: SESSION, code };
    case '42501':
      return { kind: 'permission', message: isOwnMessage(message) ? sentence(message) : PERMISSION, code };
    case '23505':
      return { kind: 'duplicate', message: 'That already exists.', code };
    case '23503':
      return {
        kind: 'blocked',
        message: isOwnMessage(message)
          ? sentence(message)
          : 'That refers to something in another workspace, or something that no longer exists.',
        code,
      };
    case '22023':
    case 'P0001':
      return { kind: 'invalid', message: isOwnMessage(message) ? sentence(message) : 'That change isn’t allowed.', code };
    case '23514':
    case '22001':
    case '22007':
    case '22008':
    case '22P02':
    case '23502':
      return { kind: 'invalid', message: 'Some of the values aren’t valid. Check the highlighted fields.', code };
    case '54000':
      return { kind: 'invalid', message: isOwnMessage(message) ? sentence(message) : 'That request is too large.', code };
    case 'P0002':
    case 'PGRST116':
      return { kind: 'notFound', message: isOwnMessage(message) ? sentence(message) : 'That item no longer exists.', code };
    case '57014': // statement timeout
      return { kind: 'unknown', message: 'That took too long. Try again.', code };
    default:
      break;
  }
  if (status === 413) return { kind: 'invalid', message: 'That is too large to send.', code };
  if (status === 401) return { kind: 'session', message: SESSION, code };
  if (status === 403) return { kind: 'permission', message: PERMISSION, code };
  return { kind: 'unknown', message: 'Something went wrong. Try again.', code };
}

// ---------------------------------------------------------------------------------------------
// Analytics reports (analytics_time_summary)
// ---------------------------------------------------------------------------------------------

export const REPORT_TOO_SLOW = 'This report took too long. Choose a shorter range or add a filter.';
export const REPORT_NEEDS_MIGRATION =
  'Analytics needs the latest database update. Ask the workspace owner to apply migration 10.';

/**
 * An error from the analytics report function. Besides `toProblem`'s rules: a statement timeout
 * asks for a narrower report, and a missing function (PGRST202: migration 10 is not applied on
 * this database yet) says so instead of "Something went wrong". Its own 22023 sentences pass
 * through as for every function; `isTimeZoneProblem` picks out the one the view handles itself.
 */
export function toReportProblem(error: unknown): Problem {
  if (!isNetworkError(error) && typeof error === 'object' && error !== null) {
    const code = (error as Coded).code;
    if (code === '57014') return { kind: 'invalid', message: REPORT_TOO_SLOW, code };
    if (code === 'PGRST202') return { kind: 'blocked', message: REPORT_NEEDS_MIGRATION, code };
  }
  return toProblem(error);
}

/**
 * The report refused its time zone ("unknown time zone", 22023): the browser knows a zone this
 * database's time zone data does not. The view falls back to UTC and forgets the saved zone.
 */
export function isTimeZoneProblem(problem: Problem): boolean {
  return problem.code === '22023' && /time zone/i.test(problem.message);
}

/** Thrown by the data layer so callers can `catch` one type. */
export class ProblemError extends Error {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.message);
    this.name = 'ProblemError';
    this.problem = problem;
  }
}

export function asProblem(error: unknown): Problem {
  return error instanceof ProblemError ? error.problem : toProblem(error);
}
