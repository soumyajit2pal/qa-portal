import React from 'react'

/* Minimal inline outline icon set (no external icon library dependency).
   All icons are 20x20 viewBox, stroke-based, currentColor. */
type IconProps = React.SVGProps<SVGSVGElement>

const base = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const IconGrid = (p: IconProps) => (
  <svg {...base} {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
)
export const IconEdit = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
)
export const IconShield = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" /></svg>
)
export const IconApprove = (p: IconProps) => (
  <svg {...base} {...p}><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>
)
export const IconSearch = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
)
export const IconStar = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12 3l2.6 5.7 6.2.6-4.7 4.2 1.4 6.1L12 16.9 6.5 19.6l1.4-6.1-4.7-4.2 6.2-.6Z" /></svg>
)
export const IconBell = (p: IconProps) => (
  <svg {...base} {...p}><path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10 21a2 2 0 0 0 4 0" /></svg>
)
export const IconHelp = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1.3 1-1.3 1.9" /><path d="M12 17h.01" /></svg>
)
export const IconApps = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="5" cy="5" r="1.4" /><circle cx="12" cy="5" r="1.4" /><circle cx="19" cy="5" r="1.4" /><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /><circle cx="5" cy="19" r="1.4" /><circle cx="12" cy="19" r="1.4" /><circle cx="19" cy="19" r="1.4" /></svg>
)
export const IconPlus = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>
)
export const IconFolder = (p: IconProps) => (
  <svg {...base} {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg>
)
export const IconPlay = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M10 8.5l6 3.5-6 3.5v-7Z" /></svg>
)
export const IconTarget = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.6" /></svg>
)
export const IconEyeOff = (p: IconProps) => (
  <svg {...base} {...p}><path d="M3 12s3.5-7 9-7c1.6 0 3 .4 4.2 1M21 12s-3.5 7-9 7c-1.6 0-3-.4-4.2-1" /><path d="M3 3l18 18" /></svg>
)
export const IconCertificate = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="9" r="6" /><path d="M9 14.5L8 21l4-2 4 2-1-6.5" /></svg>
)
export const IconChart = (p: IconProps) => (
  <svg {...base} {...p}><path d="M4 20V10M11 20V4M18 20v-7" /></svg>
)
export const IconWorkflow = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="5" cy="6" r="2.2" /><circle cx="19" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" /><path d="M7 7l10 0M6 8l5 8M18 8l-5 8" /></svg>
)
export const IconCheckCircle = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.2 2.2L16 9.5" /></svg>
)
export const IconWarning = (p: IconProps) => (
  <svg {...base} {...p}><path d="M12 3l10 18H2L12 3Z" /><path d="M12 10v4" /><path d="M12 17h.01" /></svg>
)
export const IconArrowRight = (p: IconProps) => (
  <svg {...base} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
)
export const IconLogout = (p: IconProps) => (
  <svg {...base} {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>
)
export const IconUsers = (p: IconProps) => (
  <svg {...base} {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6" /><circle cx="17" cy="8.5" r="2.4" /><path d="M15.2 14.2c2.5.4 4.3 2.8 4.3 5.8" /></svg>
)
export const IconLock = (p: IconProps) => (
  <svg {...base} {...p}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
)
export const IconFilter = (p: IconProps) => (
  <svg {...base} {...p}><path d="M4 5h16l-6 7.5V19l-4 2v-8.5L4 5Z" /></svg>
)
