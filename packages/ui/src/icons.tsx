import type { ReactNode, SVGProps } from 'react';

/**
 * Inline stroke icons drawn on a 20 x 20 grid (1.5 px stroke, round caps). Decorative by default:
 * pair them with visible text or an aria-label on the control.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
}

function createIcon(name: string, body: ReactNode, filled = false) {
  function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill={filled ? 'currentColor' : 'none'}
        stroke={filled ? 'none' : 'currentColor'}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {body}
      </svg>
    );
  }
  Icon.displayName = `Icon${name}`;
  return Icon;
}

export const IconHome = createIcon(
  'Home',
  <>
    <path d="M3.25 9.25 10 3.5l6.75 5.75" />
    <path d="M5 8v8.25h10V8" />
    <path d="M8.5 16.25v-4h3v4" />
  </>,
);

export const IconTasks = createIcon(
  'Tasks',
  <>
    <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="3" />
    <path d="m6.75 10.25 2.25 2.25 4.25-4.75" />
  </>,
);

export const IconNotes = createIcon(
  'Notes',
  <>
    <rect x="4" y="2.75" width="12" height="14.5" rx="2" />
    <path d="M7 7h6M7 10h6M7 13h3.5" />
  </>,
);

export const IconProjects = createIcon(
  'Projects',
  <path d="M2.75 6.25a2 2 0 0 1 2-2h3.1l1.75 2h5.65a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H4.75a2 2 0 0 1-2-2z" />,
);

export const IconClock = createIcon(
  'Clock',
  <>
    <circle cx="10" cy="10" r="7.25" />
    <path d="M10 6v4.25l2.75 1.75" />
  </>,
);

export const IconTeam = createIcon(
  'Team',
  <>
    <circle cx="7.5" cy="7" r="2.75" />
    <path d="M2.75 16.25c.5-2.6 2.4-4.1 4.75-4.1s4.25 1.5 4.75 4.1" />
    <circle cx="14" cy="7.75" r="2" />
    <path d="M13.75 12.15c1.85.15 3.1 1.4 3.5 3.6" />
  </>,
);

export const IconSettings = createIcon(
  'Settings',
  <>
    <path d="M3.5 5h7.25M14.5 5h2M3.5 10h2M9.25 10h7.25M3.5 15h8.25M15.5 15h1" />
    <circle cx="12.5" cy="5" r="1.75" />
    <circle cx="7.5" cy="10" r="1.75" />
    <circle cx="13.6" cy="15" r="1.75" />
  </>,
);

export const IconPause = createIcon(
  'Pause',
  <>
    <rect x="5.25" y="4.25" width="3.25" height="11.5" rx="1" />
    <rect x="11.5" y="4.25" width="3.25" height="11.5" rx="1" />
  </>,
  true,
);

export const IconPlay = createIcon('Play', <path d="M6.25 4.6v10.8a.75.75 0 0 0 1.13.65l8.6-5.4a.75.75 0 0 0 0-1.3l-8.6-5.4a.75.75 0 0 0-1.13.65z" />, true);

export const IconChevronDown = createIcon('ChevronDown', <path d="M5.5 8 10 12.5 14.5 8" />);
export const IconChevronUp = createIcon('ChevronUp', <path d="M5.5 12 10 7.5l4.5 4.5" />);
export const IconChevronRight = createIcon('ChevronRight', <path d="M8 5.5 12.5 10 8 14.5" />);
export const IconChevronLeft = createIcon('ChevronLeft', <path d="M12 5.5 7.5 10l4.5 4.5" />);
export const IconClose = createIcon('Close', <path d="m5.5 5.5 9 9m0-9-9 9" />);
export const IconPlus = createIcon('Plus', <path d="M10 4.5v11M4.5 10h11" />);
export const IconCheck = createIcon('Check', <path d="m4.75 10.25 3.5 3.5 7-7.5" />);

export const IconSearch = createIcon(
  'Search',
  <>
    <circle cx="9" cy="9" r="5.25" />
    <path d="m13 13 3.5 3.5" />
  </>,
);

export const IconTrash = createIcon(
  'Trash',
  <>
    <path d="M3.75 5.5h12.5M8 5.5V4h4v1.5" />
    <path d="m5.5 5.5.75 10.75h7.5l.75-10.75" />
    <path d="M8.5 8.5v5M11.5 8.5v5" />
  </>,
);

export const IconPencil = createIcon(
  'Pencil',
  <>
    <path d="m12.5 3.75 3.75 3.75-8.5 8.5H4v-3.75z" />
    <path d="m10.75 5.5 3.75 3.75" />
  </>,
);

export const IconRefresh = createIcon(
  'Refresh',
  <>
    <path d="M15.6 10.25a5.75 5.75 0 1 1-1.75-4.4" />
    <path d="M15.75 3.5v3.25H12.5" />
  </>,
);

export const IconDownload = createIcon(
  'Download',
  <>
    <path d="M10 3.5v9" />
    <path d="M6.25 9 10 12.75 13.75 9" />
    <path d="M4 16.25h12" />
  </>,
);

export const IconExternal = createIcon(
  'External',
  <>
    <path d="m7.25 12.75 7-7" />
    <path d="M8.5 5.75h5.75v5.75" />
  </>,
);

export const IconShield = createIcon(
  'Shield',
  <>
    <path d="M10 2.75 16 5v4.5c0 3.75-2.6 6.4-6 7.75-3.4-1.35-6-4-6-7.75V5z" />
    <path d="m7.5 10 1.75 1.75 3.5-3.25" />
  </>,
);

export const IconInfo = createIcon(
  'Info',
  <>
    <circle cx="10" cy="10" r="7.25" />
    <path d="M10 9.25v4.25M10 6.6v.05" />
  </>,
);

export const IconAlert = createIcon(
  'Alert',
  <>
    <path d="M8.7 3.95a1.5 1.5 0 0 1 2.6 0l5.8 10.3a1.5 1.5 0 0 1-1.3 2.25H4.2a1.5 1.5 0 0 1-1.3-2.25z" />
    <path d="M10 8v3.25M10 13.6v.05" />
  </>,
);

export const IconAlertCircle = createIcon(
  'AlertCircle',
  <>
    <circle cx="10" cy="10" r="7.25" />
    <path d="M10 6.25v4.5M10 13.4v.05" />
  </>,
);

export const IconCheckCircle = createIcon(
  'CheckCircle',
  <>
    <circle cx="10" cy="10" r="7.25" />
    <path d="m7 10.25 2 2 4-4.25" />
  </>,
);

export const IconXCircle = createIcon(
  'XCircle',
  <>
    <circle cx="10" cy="10" r="7.25" />
    <path d="m7.75 7.75 4.5 4.5m0-4.5-4.5 4.5" />
  </>,
);

export const IconKeyboard = createIcon(
  'Keyboard',
  <>
    <rect x="2.5" y="5" width="15" height="10" rx="2" />
    <path d="M5.75 8.25h.05M8.6 8.25h.05M11.4 8.25h.05M14.25 8.25h.05M6.75 11.75h6.5" />
  </>,
);

export const IconPower = createIcon(
  'Power',
  <>
    <path d="M10 3v6.25" />
    <path d="M6.1 5.6a6 6 0 1 0 7.8 0" />
  </>,
);

export const IconCloud = createIcon(
  'Cloud',
  <path d="M6 15.25h8.25a3.25 3.25 0 0 0 .3-6.49A4.75 4.75 0 0 0 5.4 7.6 3.85 3.85 0 0 0 6 15.25z" />,
);

export const IconDatabase = createIcon(
  'Database',
  <>
    <ellipse cx="10" cy="5" rx="6" ry="2.25" />
    <path d="M4 5v10c0 1.25 2.7 2.25 6 2.25s6-1 6-2.25V5" />
    <path d="M4 10c0 1.25 2.7 2.25 6 2.25s6-1 6-2.25" />
  </>,
);

export const IconMonitor = createIcon(
  'Monitor',
  <>
    <rect x="2.75" y="3.75" width="14.5" height="9.5" rx="1.75" />
    <path d="M7 16.25h6M10 13.25v3" />
  </>,
);

export const IconApps = createIcon(
  'Apps',
  <>
    <rect x="3.25" y="3.25" width="5.5" height="5.5" rx="1.5" />
    <rect x="11.25" y="3.25" width="5.5" height="5.5" rx="1.5" />
    <rect x="3.25" y="11.25" width="5.5" height="5.5" rx="1.5" />
    <rect x="11.25" y="11.25" width="5.5" height="5.5" rx="1.5" />
  </>,
);

export const IconLock = createIcon(
  'Lock',
  <>
    <rect x="4.5" y="8.75" width="11" height="8.25" rx="2" />
    <path d="M7 8.75V6.5a3 3 0 0 1 6 0v2.25" />
  </>,
);

export const IconPulse = createIcon('Pulse', <path d="M2.5 10.5h3.25l1.6-4.25 2.6 8.5 2.05-6.25 1.25 2h4.25" />);

export const IconFile = createIcon(
  'File',
  <>
    <path d="M5 2.75h6l4 4v10.5H5z" />
    <path d="M11 2.75v4h4" />
  </>,
);

export const IconMore = createIcon(
  'More',
  <>
    <circle cx="5" cy="10" r="1.35" />
    <circle cx="10" cy="10" r="1.35" />
    <circle cx="15" cy="10" r="1.35" />
  </>,
  true,
);

export const IconCalendar = createIcon(
  'Calendar',
  <>
    <rect x="3" y="4.25" width="14" height="12.75" rx="2" />
    <path d="M3 8.25h14M7 2.75v3M13 2.75v3" />
  </>,
);

export const IconFolderOpen = createIcon(
  'FolderOpen',
  <>
    <path d="M2.75 14.75V5.75a1.5 1.5 0 0 1 1.5-1.5h3.1l1.6 1.75h5.3a1.5 1.5 0 0 1 1.5 1.5V8" />
    <path d="M2.75 14.75 4.6 9.1A1.5 1.5 0 0 1 6 8.1h10.4a.9.9 0 0 1 .86 1.18l-1.6 5a1.5 1.5 0 0 1-1.43 1.05H4.25" />
  </>,
);
