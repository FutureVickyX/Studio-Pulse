/**
 * Autosave for one note, independent of React (unit-tested with fake timers).
 *
 * - Edits are saved after a short debounce, one save at a time.
 * - "saved" is reported only once the server confirmed the save.
 * - Every save names the version it was based on. If someone else saved in between, the save is
 *   refused and the status becomes "conflict": nothing is overwritten until the user chooses.
 *   A newer version whose text this device already knows (its own save whose response was lost,
 *   or a change that left the text alone, such as pinning) is built on instead.
 * - A failed save keeps the text (in memory and in the local draft store) and is retried with a
 *   growing delay. An ended session, a refusal, a value the server rejects or a deleted note
 *   stops the retries until the user acts.
 * - Other writes of the note (sharing, project, pin, archive) go through `writeBetween`: never
 *   alongside a save, and the version they create is the base of the next save.
 * - A late response never undoes the user's choice: after a restore into conflict or "use theirs"
 *   made while a save was on its way, it only tells what the server holds now.
 * - `dispose()` (component unmount) cancels the timer and sends any pending edit once.
 */

import { asProblem } from './errors';
import type { Problem } from './errors';

export interface NoteDraft {
  readonly title: string;
  readonly body: string;
}

export type SaveOutcome =
  | { readonly kind: 'saved'; readonly version: number }
  /** The note changed on the server since `baseVersion` (someone else saved). */
  | { readonly kind: 'conflict'; readonly server: { readonly draft: NoteDraft; readonly version: number } | null }
  /** The note is gone or no longer editable by this user. */
  | { readonly kind: 'gone' };

export type AutosaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'gone';

export interface AutosaveSnapshot {
  readonly status: AutosaveStatus;
  readonly draft: NoteDraft;
  /** The server version the next save is based on. */
  readonly version: number;
  readonly problem: Problem | null;
  /** The newer server copy, while in conflict (null when it could not be read). */
  readonly server: { readonly draft: NoteDraft; readonly version: number } | null;
  readonly lastSavedAt: number | null;
}

export interface AutosaveDeps {
  save: (draft: NoteDraft, baseVersion: number) => Promise<SaveOutcome>;
  /** Persist (or, with null, clear) unsaved text on this device, with the version it is based on. */
  storeDraft?: (draft: NoteDraft | null, baseVersion: number) => void;
  debounceMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const DEFAULT_DEBOUNCE_MS = 800;
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];

function same(a: NoteDraft, b: NoteDraft): boolean {
  return a.title === b.title && a.body === b.body;
}

/** Problems a later attempt can get past by itself; the others wait for the user. */
function retryable(problem: Problem): boolean {
  return problem.kind === 'network' || problem.kind === 'rateLimited' || problem.kind === 'unknown';
}

export class AutosaveController {
  private snapshot: AutosaveSnapshot;
  private readonly listeners = new Set<() => void>();
  private timer: unknown = null;
  /** The save on its way (one at a time). */
  private inFlight: Promise<void> | null = null;
  /** Another write of the note on its way (`writeBetween`): no save starts meanwhile. */
  private holding: Promise<void> | null = null;
  /** The server's text at `snapshot.version`, as far as this device knows. */
  private confirmed: NoteDraft;
  /** Texts sent on top of `snapshot.version` and not confirmed: a response may have been lost. */
  private unconfirmed: NoteDraft[] = [];
  private retries = 0;
  private disposed = false;
  private readonly deps: Required<Omit<AutosaveDeps, 'storeDraft'>> & Pick<AutosaveDeps, 'storeDraft'>;

  constructor(initial: NoteDraft, version: number, deps: AutosaveDeps) {
    this.deps = {
      save: deps.save,
      storeDraft: deps.storeDraft,
      debounceMs: deps.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      retryDelaysMs: deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
      now: deps.now ?? (() => Date.now()),
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    };
    this.confirmed = initial;
    this.snapshot = { status: 'saved', draft: initial, version, problem: null, server: null, lastSavedAt: null };
  }

  getSnapshot = (): AutosaveSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Unsaved work exists (warn before leaving the page). */
  hasUnsavedChanges(): boolean {
    return this.snapshot.status !== 'saved' && this.snapshot.status !== 'gone';
  }

  /** Disposed controllers ignore edits; the view replaces one it finds disposed. */
  isDisposed(): boolean {
    return this.disposed;
  }

  /** The user typed: remember it locally at once, save it after the debounce. */
  edit(draft: NoteDraft): void {
    if (this.disposed || same(draft, this.snapshot.draft)) return;
    this.deps.storeDraft?.(draft, this.snapshot.version);
    const status = this.snapshot.status === 'conflict' || this.snapshot.status === 'gone' ? this.snapshot.status : 'dirty';
    this.update({ draft, status, problem: status === 'dirty' ? null : this.snapshot.problem });
    if (status === 'dirty') {
      this.retries = 0;
      this.schedule(this.deps.debounceMs);
    }
  }

  /**
   * Text kept on this device from an earlier visit, written on top of `baseVersion`. On top of
   * the version shown now it is an ordinary edit. On top of an older one, someone saved since:
   * both are shown and the user chooses, as in any conflict.
   */
  restore(draft: NoteDraft, baseVersion: number): void {
    if (this.disposed || same(draft, this.snapshot.draft)) return;
    if (baseVersion >= this.snapshot.version) {
      this.edit(draft);
      return;
    }
    this.cancelTimer();
    const server = this.snapshot.server ?? { draft: this.confirmed, version: this.snapshot.version };
    this.deps.storeDraft?.(draft, baseVersion);
    this.update({ draft, version: baseVersion, status: 'conflict', problem: null, server });
  }

  /** Save now (blur, switching notes). Waits for a save in flight, then sends what was typed meanwhile. */
  async flush(): Promise<void> {
    while (this.inFlight) await this.inFlight;
    this.cancelTimer();
    await this.run();
  }

  /**
   * Another write of this note that moves its version (sharing, project, pin, archive). Pending
   * text is saved first and no save starts while `write` runs. `versionOf` tells the version it
   * created (null when it changed nothing), which becomes the base of the next save.
   */
  async writeBetween<T>(write: (baseVersion: number) => Promise<T>, versionOf: (result: T) => number | null): Promise<T> {
    await this.flush();
    while (this.holding || this.inFlight) {
      await (this.holding ?? this.inFlight);
      await this.flush();
    }
    let release = () => {};
    this.holding = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      // In a conflict the text waits for the user's choice; the write goes on top of the newer copy.
      const server = this.snapshot.status === 'conflict' ? this.snapshot.server : null;
      const base = server?.version ?? this.snapshot.version;
      const result = await write(base);
      const version = versionOf(result);
      if (version !== null && version > base) {
        // Such writes leave the text alone: the server has the text known for `base`, on `version`.
        const current = this.snapshot.server;
        if (this.snapshot.status === 'conflict' && current?.version === base) {
          this.update({ server: { draft: current.draft, version } });
        } else if (this.snapshot.status !== 'conflict' && this.snapshot.version === base) {
          this.rebase(this.confirmed, version);
        }
        // Otherwise the state moved on meanwhile; the next refetch settles it.
      }
      return result;
    } finally {
      this.holding = null;
      release();
      this.resume();
    }
  }

  /** Keep my text: save it on top of the newer server version. */
  async keepMine(): Promise<void> {
    const server = this.snapshot.server;
    if (this.snapshot.status !== 'conflict' || !server) return;
    this.confirmed = server.draft;
    this.unconfirmed = [];
    this.deps.storeDraft?.(this.snapshot.draft, server.version);
    this.update({ version: server.version, server: null, status: 'dirty', problem: null });
    await this.flush();
  }

  /** Take the server's text and drop my unsaved changes. */
  takeTheirs(): void {
    const server = this.snapshot.server;
    if (!server) return;
    this.cancelTimer();
    this.confirmed = server.draft;
    this.unconfirmed = [];
    this.deps.storeDraft?.(null, server.version);
    this.update({ draft: server.draft, version: server.version, server: null, status: 'saved', problem: null });
  }

  /** A newer version arrived from the server (realtime, reload). Adopt it only when nothing is pending. */
  receive(draft: NoteDraft, version: number): void {
    // While a save is in flight, a newer version may be that very save (its realtime echo can
    // arrive before the response); the response settles it either way.
    if (this.inFlight || version <= this.snapshot.version) return;
    const { status, server } = this.snapshot;
    if (status === 'saved') {
      this.confirmed = draft;
      this.unconfirmed = [];
      this.update({ draft, version });
      return;
    }
    if (same(draft, this.snapshot.draft) || ((status === 'dirty' || status === 'error') && this.knows(draft))) {
      // My own save after all (its response was lost), or the text was left alone (pinned,
      // shared): nobody else's text to choose from.
      this.rebase(draft, version);
      return;
    }
    if (status === 'conflict' && server && version <= server.version) return; // not newer than the copy shown
    // Unsaved local edits meet a newer server copy: surface it now rather than at the next save.
    this.cancelTimer();
    this.update({ status: 'conflict', server: { draft, version } });
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelTimer();
    const pending = this.snapshot.status === 'dirty' || this.snapshot.status === 'error';
    this.disposed = true;
    // One last attempt (after a running save or other write, which send it themselves); the
    // local draft stays until the server confirms.
    if (pending && !this.inFlight && !this.holding) void this.attempt();
    this.listeners.clear();
  }

  // ---- internals ----------------------------------------------------------------------------

  private update(patch: Partial<AutosaveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Text this device already knows for the current base: the server's, or one of its own unconfirmed saves. */
  private knows(draft: NoteDraft): boolean {
    return same(draft, this.confirmed) || this.unconfirmed.some((sent) => same(sent, draft));
  }

  /** The server is at `version` with `text`, which this device already knew: build on it. */
  private rebase(text: NoteDraft, version: number): void {
    this.confirmed = text;
    this.unconfirmed = [];
    if (same(this.snapshot.draft, text)) {
      // The server has exactly my text.
      const wasSaved = this.snapshot.status === 'saved';
      this.cancelTimer();
      this.retries = 0;
      if (!wasSaved) this.deps.storeDraft?.(null, version);
      this.update({
        version,
        status: 'saved',
        problem: null,
        server: null,
        lastSavedAt: wasSaved ? this.snapshot.lastSavedAt : this.deps.now(),
      });
      return;
    }
    this.deps.storeDraft?.(this.snapshot.draft, version);
    this.update({ version, status: 'dirty', problem: null, server: null });
    this.resume();
  }

  /**
   * Asked when a save's response arrives: the user acted while it was on its way, by restoring
   * text based on an older version (conflict) or taking the server's text (saved). Nothing else
   * sets either status during a save (`receive` waits for it).
   */
  private overtaken(): boolean {
    return this.snapshot.status === 'conflict' || this.snapshot.status === 'saved';
  }

  /** Send what waits, once nothing else is on its way. */
  private resume(): void {
    const { status, problem } = this.snapshot;
    if (status !== 'dirty' && !(status === 'error' && problem !== null && retryable(problem))) return;
    if (!this.disposed) this.schedule(this.deps.debounceMs);
    else if (!this.inFlight && !this.holding) void this.attempt();
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    if (this.disposed) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    const status = this.snapshot.status;
    // While another write holds the note, `writeBetween` sends the text once it is done.
    if (this.inFlight || this.holding || (status !== 'dirty' && status !== 'error')) return;
    await this.attempt();
  }

  private attempt(): Promise<void> {
    let done = () => {};
    const settled = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.inFlight = settled; // `send` clears it once the response is in
    void this.send().finally(() => done());
    return settled;
  }

  private async send(): Promise<void> {
    const sent = this.snapshot.draft;
    const baseVersion = this.snapshot.version;
    if (!this.unconfirmed.some((text) => same(text, sent))) this.unconfirmed = [...this.unconfirmed.slice(-7), sent];
    if (!this.disposed) this.update({ status: 'saving' });
    let outcome: SaveOutcome;
    try {
      outcome = await this.deps.save(sent, baseVersion);
    } catch (error) {
      this.inFlight = null;
      const problem = asProblem(error);
      // Overtaken meanwhile (see below): the text this save carried is no longer what waits.
      if (this.disposed || this.overtaken()) return;
      this.update({ status: 'error', problem });
      // Signed out, not allowed, or a value the server rejects: retrying cannot help until the user acts.
      if (retryable(problem)) {
        const delays = this.deps.retryDelaysMs;
        const delay = delays[Math.min(this.retries, delays.length - 1)] ?? 30_000;
        this.retries += 1;
        this.schedule(delay);
      } else if (!same(this.snapshot.draft, sent)) {
        // Typed while this save was on its way (its debounce may have ended meanwhile): the newer
        // text is sent as any edit is, and may well be accepted.
        this.schedule(this.deps.debounceMs);
      }
      return;
    }
    this.inFlight = null;
    if (outcome.kind !== 'gone' && this.overtaken()) {
      // The response only tells what the server holds now, as a teammate's save would: shown as
      // the copy to choose against, or adopted after "use theirs". Never saved over.
      const now = outcome.kind === 'saved' ? { draft: sent, version: outcome.version } : outcome.server;
      if (now) this.receive(now.draft, now.version);
      return;
    }
    if (outcome.kind === 'saved') {
      this.retries = 0;
      this.confirmed = sent;
      this.unconfirmed = [];
      const editedMeanwhile = !same(this.snapshot.draft, sent);
      // The local copy goes once the server has it; newer text stays, now based on this version.
      this.deps.storeDraft?.(editedMeanwhile ? this.snapshot.draft : null, outcome.version);
      // Also after an unmount (nobody listens then): a write still waiting builds on this version.
      this.update({
        version: outcome.version,
        status: editedMeanwhile ? 'dirty' : 'saved',
        problem: null,
        lastSavedAt: this.deps.now(),
      });
      this.resume(); // newer text typed meanwhile: after the debounce, or at once after an unmount
      return;
    }
    if (outcome.kind === 'conflict') {
      const server = outcome.server;
      if (server && server.version > baseVersion && this.knows(server.draft)) {
        // Not someone else's text: an earlier save of mine whose response was lost, or a change
        // that left the text alone (pinned, shared). Save again on top of it.
        this.rebase(server.draft, server.version);
        return;
      }
      this.unconfirmed = [];
      if (this.disposed) return;
      this.update({ status: 'conflict', server, problem: null });
      return;
    }
    if (this.disposed) return;
    this.update({
      status: 'gone',
      problem: { kind: 'notFound', message: 'This note was deleted or is no longer shared with you. Your text is kept on this device.' },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Local draft store (this device only)
// ---------------------------------------------------------------------------------------------

const DRAFT_PREFIX = 'studio-pulse:note-draft:';

export interface StoredDraft extends NoteDraft {
  readonly savedAt: number;
  /** The server version the draft was based on. */
  readonly baseVersion: number;
}

/**
 * Unsaved note text on this device, per signed-in user: someone else signing in on the same
 * browser never sees it.
 */
export function draftStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null, userId: string, noteId: string) {
  const key = `${DRAFT_PREFIX}${userId}:${noteId}`;
  return {
    read(): StoredDraft | null {
      try {
        const raw = storage?.getItem(key);
        if (!raw) return null;
        const value = JSON.parse(raw) as Partial<StoredDraft>;
        if (typeof value.title !== 'string' || typeof value.body !== 'string') return null;
        return {
          title: value.title,
          body: value.body,
          savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
          baseVersion: typeof value.baseVersion === 'number' ? value.baseVersion : 0,
        };
      } catch {
        return null;
      }
    },
    write(draft: NoteDraft | null, baseVersion: number, now: number): void {
      try {
        if (draft === null) storage?.removeItem(key);
        else storage?.setItem(key, JSON.stringify({ ...draft, savedAt: now, baseVersion }));
      } catch {
        // Storage full or blocked: the in-memory copy still holds the text.
      }
    },
  };
}
