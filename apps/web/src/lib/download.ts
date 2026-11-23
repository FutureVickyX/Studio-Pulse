/**
 * Saving a generated file from the page: a Blob, an object URL and a temporary `<a download>`,
 * revoked afterwards. The file is built in this tab from data already loaded; nothing is sent
 * anywhere. Used by the Analytics exports (the CSV and JSON text comes from lib/analytics.ts).
 */

export type DownloadFormat = 'csv' | 'json';

export const DOWNLOAD_MIME_TYPE: Readonly<Record<DownloadFormat, string>> = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
};

export interface DownloadFile {
  /** The suggested file name (`exportFileName`). */
  readonly fileName: string;
  /**
   * The file's text, written as UTF-8 exactly as given. A CSV's byte order mark is part of the
   * text (`toCsv` puts it there), so none is added here.
   */
  readonly content: string;
  readonly format: DownloadFormat;
}

/** The link the download is started from: the part of an `<a>` this module uses. */
export interface DownloadLink {
  href: string;
  download: string;
  rel: string;
  readonly style: { display: string };
  click(): void;
  remove(): void;
}

/** The parts of the browser a download touches. Tests pass stand-ins. */
export interface DownloadHost {
  createLink(): DownloadLink;
  /** Puts the link in the document: Firefox only follows a click on an attached link. */
  attach(link: DownloadLink): void;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** Runs `task` after the click has been handled. */
  later(task: () => void): void;
}

/** How long the object URL stays alive after the click: the browser reads it asynchronously. */
export const REVOKE_DELAY_MS = 1_000;

function browserHost(): DownloadHost {
  return {
    createLink: () => document.createElement('a'),
    attach: (link) => {
      document.body.appendChild(link as HTMLAnchorElement);
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    later: (task) => {
      window.setTimeout(task, REVOKE_DELAY_MS);
    },
  };
}

/**
 * Start a download of `file`. The temporary link is removed at once and the object URL is revoked
 * shortly after, also when the click throws. Throws where the browser has no Blob or object URLs;
 * callers show that as a problem.
 */
export function downloadFile(file: DownloadFile, host: DownloadHost = browserHost()): void {
  const blob = new Blob([file.content], { type: DOWNLOAD_MIME_TYPE[file.format] });
  const url = host.createObjectURL(blob);
  const link = host.createLink();
  try {
    link.href = url;
    link.download = file.fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    host.attach(link);
    link.click();
  } finally {
    link.remove();
    host.later(() => host.revokeObjectURL(url));
  }
}
