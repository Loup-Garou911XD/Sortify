/**
 * The icon set: one 24-grid, 1.7 stroke, `currentColor`. Inline so the UI stays dependency-free
 * and icons inherit the button colour they sit in.
 */
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconPlus = (p: Props) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconClose = (p: Props) => (
  <Icon {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);

export const IconSearch = (p: Props) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20.5 20.5-4.2-4.2" />
  </Icon>
);

export const IconMenu = (p: Props) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const IconChevronDown = (p: Props) => (
  <Icon {...p} size={p.size ?? 13}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const IconArrowLeft = (p: Props) => (
  <Icon {...p} size={p.size ?? 14}>
    <path d="M19 12H5m0 0 6-6m-6 6 6 6" />
  </Icon>
);

export const IconSun = (p: Props) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
  </Icon>
);

export const IconMoon = (p: Props) => (
  <Icon {...p}>
    <path d="M20 14.3A8.5 8.5 0 1 1 9.7 4a6.8 6.8 0 0 0 10.3 10.3Z" />
  </Icon>
);

export const IconMonitor = (p: Props) => (
  <Icon {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2" />
    <path d="M8.5 20.5h7M12 17v3.5" />
  </Icon>
);

export const IconRefresh = (p: Props) => (
  <Icon {...p}>
    <path d="M20.5 11a8.5 8.5 0 1 0-.9 5" />
    <path d="M21 4.5V11h-6.5" />
  </Icon>
);

export const IconTag = (p: Props) => (
  <Icon {...p}>
    <path d="M12.6 3H21v8.4a2 2 0 0 1-.6 1.4l-7 7a2 2 0 0 1-2.8 0l-5.4-5.4a2 2 0 0 1 0-2.8l7-7a2 2 0 0 1 1.4-.6Z" />
    <path d="M16.8 7.2h.01" />
  </Icon>
);

export const IconExternal = (p: Props) => (
  <Icon {...p} size={p.size ?? 13}>
    <path d="M14 4h6v6M20 4 11 13" />
    <path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10" />
  </Icon>
);

export const IconPlay = (p: Props) => (
  <Icon {...p} size={p.size ?? 13}>
    <path d="M7 4.8 19 12 7 19.2V4.8Z" fill="currentColor" />
  </Icon>
);

export const IconMusic = (p: Props) => (
  <Icon {...p}>
    <path d="M9 18V5l11-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="17" cy="16" r="3" />
  </Icon>
);

export const IconStop = (p: Props) => (
  <Icon {...p} size={p.size ?? 13}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Icon>
);

export const IconTrash = (p: Props) => (
  <Icon {...p}>
    <path d="M4 7h16M10 7V4.8A.8.8 0 0 1 10.8 4h2.4a.8.8 0 0 1 .8.8V7" />
    <path d="M6.5 7 7.3 19a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
  </Icon>
);

export const IconAlert = (p: Props) => (
  <Icon {...p}>
    <path d="M12 3.8 2.8 19.4a1 1 0 0 0 .86 1.5h16.68a1 1 0 0 0 .86-1.5L12 3.8Z" />
    <path d="M12 9.8v4.4M12 17.6h.01" />
  </Icon>
);

export const IconInfo = (p: Props) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 7.8h.01" />
  </Icon>
);

export const IconCheckCircle = (p: Props) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.4 12.2 2.4 2.4 4.8-4.8" />
  </Icon>
);

export const IconSignIn = (p: Props) => (
  <Icon {...p}>
    <path d="M9.5 7.5v-2A1.5 1.5 0 0 1 11 4h7.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H11a1.5 1.5 0 0 1-1.5-1.5v-2" />
    <path d="M3 12h11.5m0 0-3.2-3.2M14.5 12l-3.2 3.2" />
  </Icon>
);

export const IconSignOut = (p: Props) => (
  <Icon {...p}>
    <path d="M14.5 16.5v2a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4H13a1.5 1.5 0 0 1 1.5 1.5v2" />
    <path d="M9.5 12H21m0 0-3.2-3.2M21 12l-3.2 3.2" />
  </Icon>
);

export const IconInbox = (p: Props) => (
  <Icon {...p} size={p.size ?? 22}>
    <path d="M3.5 13.5h4l1.6 2.6h5.8l1.6-2.6h4" />
    <path d="M5.4 4.9h13.2a1.5 1.5 0 0 1 1.4 1l2 7.6v4.4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4.4l2-7.6a1.5 1.5 0 0 1 1.4-1Z" />
  </Icon>
);
