import { describe, expect, it } from 'vitest';

import { DOWNLOAD_MIME_TYPE, REVOKE_DELAY_MS, downloadFile } from '../../../apps/web/src/lib/download';
import type { DownloadHost, DownloadLink } from '../../../apps/web/src/lib/download';

/** The browser parts a download touches, as stand-ins that record what happened in order. */
function fakeHost(options: { clickThrows?: boolean } = {}) {
  const events: string[] = [];
  const blobs: Blob[] = [];
  const links: (DownloadLink & { attached: boolean; clickedWhile: Partial<DownloadLink> | null })[] = [];
  const deferred: (() => void)[] = [];
  const host: DownloadHost = {
    createLink() {
      const link = {
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        attached: false,
        clickedWhile: null as Partial<DownloadLink> | null,
        click() {
          events.push(link.attached ? 'click (attached)' : 'click (detached)');
          link.clickedWhile = { href: link.href, download: link.download, rel: link.rel, style: { display: link.style.display } };
          if (options.clickThrows) throw new Error('blocked');
        },
        remove() {
          events.push('remove');
          link.attached = false;
        },
      };
      events.push('createLink');
      links.push(link);
      return link;
    },
    attach(link) {
      events.push('attach');
      (link as (typeof links)[number]).attached = true;
    },
    createObjectURL(blob) {
      blobs.push(blob);
      events.push(`createObjectURL blob:${blobs.length}`);
      return `blob:${blobs.length}`;
    },
    revokeObjectURL(url) {
      events.push(`revokeObjectURL ${url}`);
    },
    later(task) {
      events.push('later');
      deferred.push(task);
    },
  };
  return { host, events, blobs, links, runDeferred: () => deferred.splice(0).forEach((task) => task()) };
}

const bytesOf = async (blob: Blob) => [...new Uint8Array(await blob.arrayBuffer())];
const BOM = [0xef, 0xbb, 0xbf];

describe('downloadFile', () => {
  it('starts the download from an attached, hidden link named after the file', () => {
    const { host, links, events } = fakeHost();
    downloadFile({ fileName: 'studio-pulse_time-summary_2026-11-06_2026-11-12.csv', content: 'a,b\r\n1,2\r\n', format: 'csv' }, host);

    expect(links).toHaveLength(1);
    // What the link was when it was clicked: the object URL, the file name, out of sight, in the document.
    expect(links[0]?.clickedWhile).toEqual({
      href: 'blob:1',
      download: 'studio-pulse_time-summary_2026-11-06_2026-11-12.csv',
      rel: 'noopener',
      style: { display: 'none' },
    });
    expect(events.filter((event) => event.startsWith('click'))).toEqual(['click (attached)']); // Firefox ignores a detached link
    expect(links[0]?.attached).toBe(false); // and it does not stay in the page
  });

  it('creates one object URL, and revokes it only after the click has been handled', () => {
    const { host, events, runDeferred } = fakeHost();
    downloadFile({ fileName: 'report.json', content: '{}', format: 'json' }, host);

    expect(events).toEqual(['createObjectURL blob:1', 'createLink', 'attach', 'click (attached)', 'remove', 'later']);
    // Still alive: the browser reads the URL after the click returns.
    expect(events.some((event) => event.startsWith('revokeObjectURL'))).toBe(false);
    runDeferred();
    expect(events.filter((event) => event.startsWith('revokeObjectURL'))).toEqual(['revokeObjectURL blob:1']);
    expect(REVOKE_DELAY_MS).toBeGreaterThan(0);
  });

  it('writes the text as UTF-8 with the format’s type, byte for byte', async () => {
    const csv = fakeHost();
    const content = 'Project,Active\r\n"Café, ünïcode ✓",1h 30m\r\n';
    downloadFile({ fileName: 'a.csv', content, format: 'csv' }, csv.host);
    expect(csv.blobs).toHaveLength(1);
    expect(csv.blobs[0]?.type).toBe('text/csv;charset=utf-8');
    expect(DOWNLOAD_MIME_TYPE.csv).toBe('text/csv;charset=utf-8');
    expect(await bytesOf(csv.blobs[0] as Blob)).toEqual([...new TextEncoder().encode(content)]);
    expect((await bytesOf(csv.blobs[0] as Blob)).slice(0, 3)).not.toEqual(BOM); // none added here

    const json = fakeHost();
    downloadFile({ fileName: 'a.json', content: '{"total":1}\n', format: 'json' }, json.host);
    expect(json.blobs[0]?.type).toBe('application/json;charset=utf-8');
    expect(await json.blobs[0]?.text()).toBe('{"total":1}\n');
  });

  it('keeps a byte order mark that is part of the text, once', async () => {
    const { host, blobs } = fakeHost();
    downloadFile({ fileName: 'a.csv', content: '﻿a,b\r\n', format: 'csv' }, host);
    const bytes = await bytesOf(blobs[0] as Blob);
    expect(bytes.slice(0, 3)).toEqual(BOM);
    expect(bytes.slice(3, 6)).not.toEqual(BOM);
    expect(bytes).toHaveLength(3 + 'a,b\r\n'.length);
  });

  it('an empty file is still a file', async () => {
    const { host, blobs, links } = fakeHost();
    downloadFile({ fileName: 'empty.csv', content: '', format: 'csv' }, host);
    expect(blobs[0]?.size).toBe(0);
    expect(links[0]?.clickedWhile?.download).toBe('empty.csv');
  });

  it('cleans up when the click throws: the link is removed and the URL revoked, and the error is not hidden', () => {
    const { host, events, links, runDeferred } = fakeHost({ clickThrows: true });
    expect(() => downloadFile({ fileName: 'a.csv', content: 'x', format: 'csv' }, host)).toThrow('blocked');
    expect(links[0]?.attached).toBe(false);
    expect(events.slice(-2)).toEqual(['remove', 'later']);
    runDeferred();
    expect(events[events.length - 1]).toBe('revokeObjectURL blob:1');
  });

  it('each download has its own URL and link', () => {
    const { host, events, links, runDeferred } = fakeHost();
    downloadFile({ fileName: 'one.csv', content: '1', format: 'csv' }, host);
    downloadFile({ fileName: 'two.json', content: '2', format: 'json' }, host);
    expect(links.map((link) => link.clickedWhile?.href)).toEqual(['blob:1', 'blob:2']);
    expect(links.map((link) => link.clickedWhile?.download)).toEqual(['one.csv', 'two.json']);
    runDeferred();
    expect(events.filter((event) => event.startsWith('revokeObjectURL'))).toEqual(['revokeObjectURL blob:1', 'revokeObjectURL blob:2']);
  });
});
