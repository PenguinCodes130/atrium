// Shell icon set: 24px grid, 1.75 stroke, square caps and mitred joins (design v4 Control Room),
// currentColor. Decorative unless given a label.
import type { ReactNode, SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const HomeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />
  </Icon>
);
export const PageIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M4 9.5h16M10 9.5V20" />
  </Icon>
);
export const PagesIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="6.5" width="13" height="13" rx="2.5" />
    <path d="M7.5 3.5h10a3 3 0 0 1 3 3v10" />
  </Icon>
);
export const PlugIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 3v4M15 3v4M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0zM12 16v5" />
  </Icon>
);
export const ApprovalIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 19 6v5.5c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Icon>
);
export const AuditIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 4h10a2 2 0 0 1 2 2v14l-3-1.8-3 1.8-3-1.8L7 20z" transform="translate(-1 0)" />
    <path d="M9 9h6M9 13h4" />
  </Icon>
);
export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
  </Icon>
);
export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Icon>
);
export const MoreIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="18" cy="12" r="1.2" fill="currentColor" />
  </Icon>
);
export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
export const SidebarIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <path d="M9.5 4.5v15" />
  </Icon>
);
export const EditIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
    <path d="m13.5 6.5 4 4" />
  </Icon>
);
export const TrayIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 13.5 6.5 5h11l2.5 8.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
    <path d="M4 13.5h4.5l1 2h5l1-2H20" />
  </Icon>
);
export const UserIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
  </Icon>
);
export const InfoIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8v.2" />
  </Icon>
);
export const CheckCircleIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.2 2.4 2.4 4.6-5" />
  </Icon>
);
export const WarnIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4 21 19.5H3z" />
    <path d="M12 10v4.5M12 17v.2" />
  </Icon>
);
export const ErrorIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2.5" />
    <path d="M12 8v5M12 15.8v.2" />
  </Icon>
);
export const LockIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </Icon>
);
export const OfflineIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.8a10 10 0 0 1 4.3-2.4M19 12.8a10 10 0 0 0-3-2M2 9a15 15 0 0 1 4.6-2.8M22 9a15 15 0 0 0-10-3.9" />
    <circle cx="12" cy="19.5" r="0.8" fill="currentColor" />
  </Icon>
);
export const GripIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="7" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="7" r="1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="17" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="17" r="1" fill="currentColor" stroke="none" />
  </Icon>
);

export const AppsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
  </Icon>
);
export const LibraryIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4h4v16H4zM10 4h4v16h-4zM16.2 4.6l3.8 1-3.9 14.4-3.8-1" />
  </Icon>
);
export const KeyHintIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 5h14v14H5z" />
  </Icon>
);
