import { describe, expect, it, vi } from 'vitest';

import { AutosaveController, draftStore } from '../../../apps/web/src/lib/autosave';
import type { AutosaveDeps, NoteDraft, SaveOutcome } from '../../../apps/web/src/lib/autosave';

/** A manual clock and timer queue (no real time passes). */
function scheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    now: () => now,
    /** Advance time, running due timers in order (and awaiting the work they start). */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const A: NoteDraft = { title: 'Brief', body: 'v1' };

function setup(save: AutosaveDeps['save'], extra: Partial<AutosaveDeps> = {}, version = 1) {
  const clock = scheduler();
  const stored: (NoteDraft | null)[] = [];
  const controller = new AutosaveController(A, version, {
    save,
    storeDraft: (d) => stored.push(d),
    debounceMs: 800,
    retryDelaysMs: [2_000, 5_000],
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    ...extra,
  });
  return { clock, controller, stored };
}

describe('autosave', () => {
  it('debounces edits into one save and reports "saved" only after the server confirmed', async () => {
    const reply = deferred<SaveOutcome>();
    const save = vi.fn(() => reply.promise);
    const { clock, controller, stored } = setup(save);

    controller.edit({ title: 'Brief', body: 'v2' });
    controller.edit({ title: 'Brief', body: 'v3' });
    expect(controller.getSnapshot().status).toBe('dirty');
    expect(stored.at(-1)).toEqual({ title: 'Brief', body: 'v3' }); // kept locally at once
    await clock.advance(799);
    expect(save).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: 'Brief', body: 'v3' }, 1);
    expect(controller.getSnapshot().status).toBe('saving');

    reply.resolve({ kind: 'saved', version: 2 });
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 2 });
    expect(stored.at(-1)).toBeNull(); // the local copy is cleared once the server has it
  });

  it('text typed during a save is saved next, on top of the new version (never two saves at once)', async () => {
    const first = deferred<SaveOutcome>();
    const save = vi.fn<AutosaveDeps['save']>().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ kind: 'saved', version: 3 });
    const { clock, controller } = setup(save);

    controller.edit({ title: 'Brief', body: 'a' });
    await clock.advance(800);
    controller.edit({ title: 'Brief', body: 'ab' });
    await clock.advance(800); // timer fires while the first save is in flight: no second request
    expect(save).toHaveBeenCalledTimes(1);

    first.resolve({ kind: 'saved', version: 2 });
    await flush();
    expect(controller.getSnapshot().status).toBe('dirty');
    await clock.advance(800);
    expect(save).toHaveBeenLastCalledWith({ title: 'Brief', body: 'ab' }, 2);
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 3 });
  });

  it('a newer server version is a conflict: nothing is overwritten until the user chooses', async () => {
    const theirs = { draft: { title: 'Brief', body: 'their text' }, version: 5 };
    const save = vi.fn<AutosaveDeps['save']>().mockResolvedValueOnce({ kind: 'conflict', server: theirs });
    const { clock, controller } = setup(save);

    controller.edit({ title: 'Brief', body: 'my text' });
    await clock.advance(800);
    expect(controller.getSnapshot()).toMatchObject({ status: 'conflict', server: theirs, version: 1 });
    // Further typing does not save while in conflict.
    controller.edit({ title: 'Brief', body: 'my text!' });
    await clock.advance(10_000);
    expect(save).toHaveBeenCalledTimes(1);

    // Keep mine: saved deliberately on top of their version.
    save.mockResolvedValueOnce({ kind: 'saved', version: 6 });
    await controller.keepMine();
    expect(save).toHaveBeenLastCalledWith({ title: 'Brief', body: 'my text!' }, 5);
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 6 });
  });

  it('“use theirs” drops my unsaved text and adopts the server copy', async () => {
    const theirs = { draft: { title: 'T', body: 'theirs' }, version: 9 };
    const { clock, controller, stored } = setup(vi.fn<AutosaveDeps['save']>().mockResolvedValue({ kind: 'conflict', server: theirs }));
    controller.edit({ title: 'T', body: 'mine' });
    await clock.advance(800);
    controller.takeTheirs();
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', draft: theirs.draft, version: 9 });
    expect(stored.at(-1)).toBeNull();
  });

  it('a failed save keeps the text, says so, and retries with a growing delay', async () => {
    const save = vi
      .fn<AutosaveDeps['save']>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ kind: 'saved', version: 2 });
    const { clock, controller, stored } = setup(save);

    controller.edit({ title: 'Brief', body: 'offline text' });
    await clock.advance(800);
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', draft: { body: 'offline text' } });
    expect(controller.getSnapshot().problem?.kind).toBe('network');
    expect(stored.at(-1)).toEqual({ title: 'Brief', body: 'offline text' });
    expect(controller.hasUnsavedChanges()).toBe(true);

    await clock.advance(1_999);
    expect(save).toHaveBeenCalledTimes(1);
    await clock.advance(1); // +2 s
    expect(save).toHaveBeenCalledTimes(2);
    await clock.advance(4_999);
    expect(save).toHaveBeenCalledTimes(2);
    await clock.advance(1); // +5 s
    expect(save).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 2 });
    expect(stored.at(-1)).toBeNull();
  });

  it('an ended session is not retried (signing in again is needed), the text is kept', async () => {
    const save = vi.fn<AutosaveDeps['save']>().mockRejectedValue({ code: 'PGRST301', message: 'JWT expired' });
    const { clock, controller } = setup(save);
    controller.edit({ title: 'Brief', body: 'x' });
    await clock.advance(800);
    expect(controller.getSnapshot().problem?.kind).toBe('session');
    await clock.advance(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().draft.body).toBe('x');
  });

  it('a deleted or unshared note stops autosave and keeps the text on the device', async () => {
    const { clock, controller, stored } = setup(vi.fn<AutosaveDeps['save']>().mockResolvedValue({ kind: 'gone' }));
    controller.edit({ title: 'Brief', body: 'keep me' });
    await clock.advance(800);
    expect(controller.getSnapshot().status).toBe('gone');
    expect(stored.at(-1)).toEqual({ title: 'Brief', body: 'keep me' });
  });

  it('unmount: cancels the timer and sends the pending edit once', async () => {
    const save = vi.fn<AutosaveDeps['save']>().mockResolvedValue({ kind: 'saved', version: 2 });
    const { clock, controller } = setup(save);
    controller.edit({ title: 'Brief', body: 'last words' });
    controller.dispose();
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: 'Brief', body: 'last words' }, 1);
    expect(clock.pending()).toBe(0);
    // The view replaces a controller it finds disposed (StrictMode remounts once in development).
    expect(controller.isDisposed()).toBe(true);
    controller.edit({ title: 'Brief', body: 'ignored' });
    expect(controller.getSnapshot().draft.body).toBe('last words');
  });

  it('unmount during a save sends text typed after it started', async () => {
    const first = deferred<SaveOutcome>();
    const save = vi.fn<AutosaveDeps['save']>().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ kind: 'saved', version: 3 });
    const { clock, controller } = setup(save);
    controller.edit({ title: 'Brief', body: 'one' });
    await clock.advance(800);
    controller.edit({ title: 'Brief', body: 'one two' });
    controller.dispose();
    first.resolve({ kind: 'saved', version: 2 });
    await flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ title: 'Brief', body: 'one two' }, 2);
  });

  it('a teammate’s newer version is adopted when nothing is pending, and is a conflict when I have unsaved text', async () => {
    const reply = deferred<SaveOutcome>();
    const { clock, controller } = setup(vi.fn(() => reply.promise));
    controller.receive({ title: 'Brief', body: 'from Bo' }, 2);
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 2, draft: { body: 'from Bo' } });
    controller.receive({ title: 'Brief', body: 'stale' }, 2); // not newer: ignored
    expect(controller.getSnapshot().draft.body).toBe('from Bo');

    controller.edit({ title: 'Brief', body: 'mine' });
    controller.receive({ title: 'Brief', body: 'from Cy' }, 3);
    expect(controller.getSnapshot()).toMatchObject({ status: 'conflict', server: { version: 3 } });
    expect(clock.pending()).toBe(0);
  });

  it('ignores a newer version while a save is in flight (it may be that save’s own echo)', async () => {
    const reply = deferred<SaveOutcome>();
    const { clock, controller } = setup(vi.fn(() => reply.promise));
    controller.edit({ title: 'Brief', body: 'mine' });
    await clock.advance(800);
    controller.edit({ title: 'Brief', body: 'mine more' });
    controller.receive({ title: 'Brief', body: 'mine' }, 2); // realtime echo of the in-flight save
    expect(controller.getSnapshot().status).not.toBe('conflict');
    reply.resolve({ kind: 'saved', version: 2 });
    await flush();
    expect(controller.getSnapshot()).toMatchObject({ status: 'dirty', version: 2 });
  });

  it('flush waits for a save in flight, then sends what was typed meanwhile', async () => {
    const first = deferred<SaveOutcome>();
    const save = vi.fn<AutosaveDeps['save']>().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ kind: 'saved', version: 3 });
    const { clock, controller } = setup(save);
    controller.edit({ title: 'Brief', body: 'a' });
    await clock.advance(800);
    controller.edit({ title: 'Brief', body: 'ab' });

    let flushed = false;
    const flushing = controller.flush().then(() => {
      flushed = true;
    });
    await flush();
    expect(flushed).toBe(false); // still waiting for the first save
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve({ kind: 'saved', version: 2 });
    await flushing;
    expect(save).toHaveBeenLastCalledWith({ title: 'Brief', body: 'ab' }, 2);
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 3 });
    expect(clock.pending()).toBe(0);
  });

  it('another write of the note (pin, share) waits for the save, holds new saves, and the next save builds on its version', async () => {
    const first = deferred<SaveOutcome>();
    const save = vi.fn<AutosaveDeps['save']>().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ kind: 'saved', version: 4 });
    const { clock, controller } = setup(save);
    controller.edit({ title: 'Brief', body: 'typed' });
    await clock.advance(800); // a save on version 1 is in flight

    const pinned = deferred<number>();
    const write = vi.fn((_base: number) => pinned.promise);
    const pinning = controller.writeBetween(write, (version) => version);
    await flush();
    expect(write).not.toHaveBeenCalled(); // never alongside a save
    first.resolve({ kind: 'saved', version: 2 });
    await flush();
    expect(write).toHaveBeenCalledWith(2);

    controller.edit({ title: 'Brief', body: 'typed more' });
    await clock.advance(5_000);
    expect(save).toHaveBeenCalledTimes(1); // held while the other write runs
    pinned.resolve(3);
    await pinning;
    expect(controller.getSnapshot()).toMatchObject({ status: 'dirty', version: 3 });
    await clock.advance(800);
    expect(save).toHaveBeenLastCalledWith({ title: 'Brief', body: 'typed more' }, 3);
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 4 });
  });

  it('a save whose response was lost is not someone else’s conflict when its echo arrives', async () => {
    const save = vi.fn<AutosaveDeps['save']>().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { clock, controller, stored } = setup(save);
    controller.edit({ title: 'Brief', body: 'landed' });
    await clock.advance(800);
    expect(controller.getSnapshot().status).toBe('error');

    controller.receive({ title: 'Brief', body: 'landed' }, 2); // it did land: this is its realtime echo
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 2, server: null, problem: null });
    expect(stored.at(-1)).toBeNull();
    await clock.advance(60_000);
    expect(save).toHaveBeenCalledTimes(1); // nothing left to retry
  });

  it('a retry that meets an earlier save of mine (its response lost) builds on it', async () => {
    const save = vi
      .fn<AutosaveDeps['save']>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ kind: 'conflict', server: { draft: { title: 'Brief', body: 'one' }, version: 2 } })
      .mockResolvedValueOnce({ kind: 'saved', version: 3 });
    const { clock, controller } = setup(save);
    controller.edit({ title: 'Brief', body: 'one' });
    await clock.advance(800); // lands, but the response is lost
    controller.edit({ title: 'Brief', body: 'one two' });
    await clock.advance(800); // refused: the server is at version 2 with my earlier text
    expect(controller.getSnapshot()).toMatchObject({ status: 'dirty', version: 2 });
    await clock.advance(800);
    expect(save).toHaveBeenLastCalledWith({ title: 'Brief', body: 'one two' }, 2);
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 3 });
  });

  it('a newer version with the text I started from (pinned, shared) is no conflict while I type', async () => {
    const save = vi
      .fn<AutosaveDeps['save']>()
      .mockResolvedValueOnce({ kind: 'conflict', server: { draft: A, version: 3 } })
      .mockResolvedValueOnce({ kind: 'saved', version: 4 });
    const { clock, controller } = setup(save);
    controller.edit({ title: 'Brief', body: 'mine' });
    controller.receive(A, 2); // realtime: the owner pinned it
    expect(controller.getSnapshot()).toMatchObject({ status: 'dirty', version: 2 });

    await clock.advance(800); // refused: shared meanwhile (version 3), text still as I started
    expect(save).toHaveBeenNthCalledWith(1, { title: 'Brief', body: 'mine' }, 2);
    expect(controller.getSnapshot()).toMatchObject({ status: 'dirty', version: 3 });
    await clock.advance(800);
    expect(save).toHaveBeenLastCalledWith({ title: 'Brief', body: 'mine' }, 3);
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 4 });
  });

  it('a value the server rejects is not retried; the text is kept until it changes', async () => {
    const save = vi
      .fn<AutosaveDeps['save']>()
      .mockRejectedValueOnce({ code: '23514', message: 'new row for relation "notes" violates check constraint "notes_body_check"' })
      .mockResolvedValueOnce({ kind: 'saved', version: 2 });
    const { clock, controller } = setup(save);
    controller.edit({ title: 'Brief', body: 'far too long' });
    await clock.advance(800);
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', draft: { body: 'far too long' } });
    expect(controller.getSnapshot().problem?.kind).toBe('invalid');
    await clock.advance(120_000);
    expect(save).toHaveBeenCalledTimes(1);

    controller.edit({ title: 'Brief', body: 'short' });
    await clock.advance(800);
    expect(save).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 2 });
  });

  it('text typed while a rejected save was on its way is still sent (it changed, so it may be accepted)', async () => {
    const first = deferred<SaveOutcome>();
    const save = vi.fn<AutosaveDeps['save']>().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ kind: 'saved', version: 2 });
    const { clock, controller, stored } = setup(save);
    controller.edit({ title: 'Brief', body: 'far too long' });
    await clock.advance(800);
    controller.edit({ title: 'Brief', body: 'short' });
    await clock.advance(800); // its debounce ends while the long text is still on its way
    first.reject({ code: '23514', message: 'new row for relation "notes" violates check constraint "notes_body_check"' });
    await flush();
    expect(controller.getSnapshot().problem?.kind).toBe('invalid');
    await clock.advance(800);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ title: 'Brief', body: 'short' }, 1);
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 2 });
    expect(stored.at(-1)).toBeNull();
  });

  it('restoring text kept from an older version is a conflict with the current text, never an overwrite', async () => {
    const save = vi.fn<AutosaveDeps['save']>().mockResolvedValue({ kind: 'saved', version: 8 });
    const { clock, controller } = setup(save, {}, 7);
    const offline = { title: 'Brief', body: 'typed offline' };
    controller.restore(offline, 3); // written on top of version 3; teammates saved up to 7 since
    expect(controller.getSnapshot()).toMatchObject({ status: 'conflict', draft: offline, server: { draft: A, version: 7 } });
    await clock.advance(10_000);
    expect(save).not.toHaveBeenCalled();

    await controller.keepMine();
    expect(save).toHaveBeenCalledWith(offline, 7);
    expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 8 });

    // On top of the version shown now, it is an ordinary edit.
    const current = setup(save, {}, 7);
    current.controller.restore(offline, 7);
    expect(current.controller.getSnapshot()).toMatchObject({ status: 'dirty', draft: offline });
  });

  describe('restoring an older draft while a save is on its way (clicking “Restore them” blurs the text and sends it)', () => {
    const offline = { title: 'Brief', body: 'typed offline' }; // kept on this device, written on top of version 3
    const typed = { title: 'Brief', body: 'typed now' };

    /** The note is at version 7; `typed` is being saved on top of it when the draft is restored. */
    async function restoreDuringSave() {
      const reply = deferred<SaveOutcome>();
      const kept: [NoteDraft | null, number][] = [];
      // Any further save would answer "saved" (version 99): the tests check none is sent.
      const save = vi.fn<AutosaveDeps['save']>().mockResolvedValue({ kind: 'saved', version: 99 }).mockReturnValueOnce(reply.promise);
      const { clock, controller } = setup(save, { storeDraft: (draft, base) => kept.push([draft, base]) }, 7);
      controller.edit(typed);
      await clock.advance(800);
      expect(save).toHaveBeenCalledWith(typed, 7);
      controller.restore(offline, 3);
      expect(controller.getSnapshot()).toMatchObject({ status: 'conflict', draft: offline, server: { draft: A, version: 7 } });
      return { reply, save, kept, clock, controller };
    }

    it('the save lands: its text is the server copy to choose against, never overwritten', async () => {
      const { reply, save, kept, clock, controller } = await restoreDuringSave();
      reply.resolve({ kind: 'saved', version: 8 });
      await flush();
      await clock.advance(10_000);
      expect(save).toHaveBeenCalledTimes(1); // nothing written over version 8
      expect(controller.getSnapshot()).toMatchObject({ status: 'conflict', draft: offline, server: { draft: typed, version: 8 } });
      expect(kept.at(-1)).toEqual([offline, 3]); // still known to be older than the note

      save.mockResolvedValueOnce({ kind: 'saved', version: 9 });
      await controller.keepMine();
      expect(save).toHaveBeenLastCalledWith(offline, 8);
      expect(controller.getSnapshot()).toMatchObject({ status: 'saved', version: 9 });
    });

    it('the save is refused: the newer copy is shown, even one with text this device knows', async () => {
      const theirs = { draft: { title: 'Brief', body: 'from Bo' }, version: 9 };
      const refused = await restoreDuringSave();
      refused.reply.resolve({ kind: 'conflict', server: theirs });
      await flush();
      await refused.clock.advance(10_000);
      expect(refused.save).toHaveBeenCalledTimes(1);
      expect(refused.controller.getSnapshot()).toMatchObject({ status: 'conflict', draft: offline, server: theirs });

      const pinned = await restoreDuringSave(); // pinned meanwhile: version 8 still has the text of version 7
      pinned.reply.resolve({ kind: 'conflict', server: { draft: A, version: 8 } });
      await flush();
      await pinned.clock.advance(10_000);
      expect(pinned.save).toHaveBeenCalledTimes(1);
      expect(pinned.controller.getSnapshot()).toMatchObject({ status: 'conflict', draft: offline, server: { draft: A, version: 8 } });
    });

    it('the save fails: still a conflict, and nothing is retried', async () => {
      const { reply, save, clock, controller } = await restoreDuringSave();
      reply.reject(new TypeError('Failed to fetch'));
      await flush();
      await clock.advance(60_000);
      expect(save).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot()).toMatchObject({ status: 'conflict', draft: offline, problem: null, server: { draft: A, version: 7 } });
    });

    it('“use theirs” before the response: a save that landed is the text to show, nothing is written again', async () => {
      const { reply, save, clock, controller } = await restoreDuringSave();
      controller.takeTheirs();
      reply.resolve({ kind: 'saved', version: 8 });
      await flush();
      await clock.advance(10_000);
      expect(save).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot()).toMatchObject({ status: 'saved', draft: typed, version: 8 });
    });

    it('“keep my version” before the response: waits for it, and a teammate’s save is still never overwritten', async () => {
      const theirs = { draft: { title: 'Brief', body: 'from Bo' }, version: 9 };
      const refused = await restoreDuringSave();
      const keeping = refused.controller.keepMine();
      refused.reply.resolve({ kind: 'conflict', server: theirs });
      await keeping;
      await refused.clock.advance(10_000);
      expect(refused.save).toHaveBeenCalledTimes(1);
      expect(refused.controller.getSnapshot()).toMatchObject({ status: 'conflict', draft: offline, server: theirs });

      // My own save landed: my restored text goes on top of it, as chosen.
      const landed = await restoreDuringSave();
      const keepingMine = landed.controller.keepMine();
      landed.reply.resolve({ kind: 'saved', version: 8 });
      await keepingMine;
      expect(landed.save).toHaveBeenCalledTimes(2);
      expect(landed.save).toHaveBeenLastCalledWith(offline, 8);
    });

    it('unmounting before the response leaves the restored draft on the device and sends nothing', async () => {
      const { reply, save, kept, clock, controller } = await restoreDuringSave();
      controller.dispose();
      reply.resolve({ kind: 'saved', version: 8 });
      await flush();
      await clock.advance(10_000);
      expect(save).toHaveBeenCalledTimes(1);
      expect(kept.at(-1)).toEqual([offline, 3]);
    });
  });

  it('a write waiting for a save that ends after unmount builds on the version that save created', async () => {
    const first = deferred<SaveOutcome>();
    const save = vi.fn<AutosaveDeps['save']>().mockResolvedValue({ kind: 'saved', version: 99 }).mockReturnValueOnce(first.promise);
    const { clock, controller } = setup(save);
    controller.edit({ title: 'Brief', body: 'typed' });
    await clock.advance(800);
    const write = vi.fn((_base: number) => Promise.resolve(3));
    const pinning = controller.writeBetween(write, (version) => version);
    controller.dispose(); // left the note right after pinning it
    first.resolve({ kind: 'saved', version: 2 });
    await pinning;
    expect(write).toHaveBeenCalledWith(2);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('draft store', () => {
  function memory(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
  }

  it('round-trips, clears, and tolerates corrupt or missing storage', () => {
    const storage = memory();
    const store = draftStore(storage, 'u1', 'n1');
    expect(store.read()).toBeNull();
    store.write({ title: 'T', body: 'B' }, 4, 1000);
    expect(store.read()).toEqual({ title: 'T', body: 'B', savedAt: 1000, baseVersion: 4 });
    store.write(null, 0, 0);
    expect(store.read()).toBeNull();
    storage.data.set('studio-pulse:note-draft:u1:n1', '{not json');
    expect(store.read()).toBeNull();
    expect(draftStore(null, 'u1', 'n1').read()).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    expect(draftStore(throwing, 'u1', 'n2').read()).toBeNull();
    expect(() => draftStore(throwing, 'u1', 'n2').write({ title: '', body: 'x' }, 1, 1)).not.toThrow();
  });

  it('belongs to the signed-in user: someone else on the same browser never sees it', () => {
    const storage = memory();
    draftStore(storage, 'alice', 'n1').write({ title: 'Private', body: 'unsaved' }, 2, 1000);
    expect(draftStore(storage, 'bob', 'n1').read()).toBeNull();
    expect(draftStore(storage, 'alice', 'n1').read()).toMatchObject({ body: 'unsaved', baseVersion: 2 });
  });
});
