import { afterEach, describe, expect, it } from 'vitest';

import { clearQueries, holdsRow, setQueryData } from '../../../apps/web/src/lib/store';

afterEach(() => clearQueries());

describe('holdsRow: which realtime deletes concern this workspace', () => {
  it('finds a row in a cached list or a single cached row, only under the prefix', () => {
    setQueryData('ws:a:tasks', () => [{ id: 't1' }, { id: 't2' }]);
    setQueryData('ws:a:task:t1:subtasks', () => [{ id: 's1' }]);
    setQueryData('ws:a:profile', () => ({ id: 'p1' }));
    setQueryData('ws:b:notes', () => [{ id: 'n1' }]);

    expect(holdsRow('ws:a:', 't2')).toBe(true);
    expect(holdsRow('ws:a:', 's1')).toBe(true);
    expect(holdsRow('ws:a:', 'p1')).toBe(true);
    // Another workspace's row, or a row nobody has loaded, is not ours.
    expect(holdsRow('ws:a:', 'n1')).toBe(false);
    expect(holdsRow('ws:a:', 'unknown')).toBe(false);
  });

  it('ignores empty and non-row data', () => {
    setQueryData('ws:a:count', () => 3);
    setQueryData('ws:a:nothing', () => null);
    expect(holdsRow('ws:a:', '3')).toBe(false);
  });
});
