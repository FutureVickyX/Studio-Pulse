import { describe, expect, it, vi } from 'vitest';

import { createLiveResource } from '../../../apps/desktop/src/lib/resource';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness<T>() {
  const loads: Array<Deferred<T>> = [];
  const load = vi.fn(() => {
    const next = deferred<T>();
    loads.push(next);
    return next.promise;
  });
  return { loads, load };
}

describe('createLiveResource', () => {
  it('loads on the first subscriber and shares one value with every subscriber', async () => {
    const { loads, load } = harness<string>();
    const resource = createLiveResource({ load });
    expect(resource.getSnapshot()).toEqual({ data: undefined, error: null, loading: false });

    const a = vi.fn();
    const b = vi.fn();
    const stopA = resource.subscribe(a);
    const stopB = resource.subscribe(b);
    expect(load).toHaveBeenCalledTimes(1);
    expect(resource.getSnapshot().loading).toBe(true);

    loads[0]!.resolve('first');
    await flush();
    expect(resource.getSnapshot()).toEqual({ data: 'first', error: null, loading: false });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    stopA();
    stopB();
  });

  it('discards a load that was overtaken by an event (set) — the event is newer', async () => {
    const { loads, load } = harness<string>();
    const resource = createLiveResource({ load });
    const stop = resource.subscribe(() => undefined);

    resource.set('from event');
    loads[0]!.resolve('stale command result');
    await flush();
    expect(resource.getSnapshot()).toEqual({ data: 'from event', error: null, loading: false });
    stop();
  });

  it('keeps only the latest of overlapping reloads', async () => {
    const { loads, load } = harness<string>();
    const resource = createLiveResource({ load });
    const stop = resource.subscribe(() => undefined);
    void resource.reload();

    loads[1]!.resolve('newer');
    await flush();
    loads[0]!.resolve('older');
    await flush();
    expect(resource.getSnapshot().data).toBe('newer');
    stop();
  });

  it('keeps the previous value and normalises the error when a reload fails', async () => {
    const { loads, load } = harness<string>();
    const resource = createLiveResource({ load });
    const stop = resource.subscribe(() => undefined);
    loads[0]!.resolve('good');
    await flush();

    void resource.reload();
    loads[1]!.reject({ code: 'storage', message: 'The database is locked.' });
    await flush();
    const snapshot = resource.getSnapshot();
    expect(snapshot.data).toBe('good');
    expect(snapshot.loading).toBe(false);
    expect(snapshot.error).toMatchObject({ code: 'storage', message: 'The database is locked.' });

    resource.set('recovered');
    expect(resource.getSnapshot().error).toBeNull();
    stop();
  });

  it('listens to events only while subscribed, and never leaks the listener', async () => {
    const { loads, load } = harness<number>();
    const teardown = vi.fn();
    let push: ((value: number) => void) | null = null;
    const listen = vi.fn((set: (value: number) => void) => {
      push = set;
      return teardown;
    });
    const resource = createLiveResource({ load, listen });

    const stopA = resource.subscribe(() => undefined);
    const stopB = resource.subscribe(() => undefined);
    expect(listen).toHaveBeenCalledTimes(1);
    loads[0]!.resolve(1);
    await flush();

    push!(2);
    expect(resource.getSnapshot().data).toBe(2);

    stopA();
    expect(teardown).not.toHaveBeenCalled();
    stopB();
    expect(teardown).toHaveBeenCalledTimes(1);

    // A later subscriber listens again and revalidates, keeping the cached value meanwhile.
    const stopC = resource.subscribe(() => undefined);
    expect(listen).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(2);
    expect(resource.getSnapshot()).toMatchObject({ data: 2, loading: true });
    loads[1]!.resolve(3);
    await flush();
    expect(resource.getSnapshot().data).toBe(3);
    stopC();
    expect(teardown).toHaveBeenCalledTimes(2);
  });
});
