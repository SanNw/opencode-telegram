import type { ReactNode, SVGProps } from "react"

export type IconName =
  | "agents" | "arrow-left" | "check" | "chevron-down" | "chevron-right"
  | "close" | "external" | "file" | "folder" | "home" | "image"
  | "menu" | "plus" | "projects" | "refresh" | "send" | "settings"

const paths: Record<IconName, ReactNode> = {
  agents: <><circle cx="12" cy="7" r="3"/><circle cx="6.5" cy="17" r="3"/><circle cx="17.5" cy="17" r="3"/><path d="m10.5 9.6-2.5 4.3m5.5-4.3 2.5 4.3M9.5 17h5"/></>,
  "arrow-left": <><path d="m14 6-6 6 6 6"/><path d="M8 12h10"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  "chevron-down": <path d="m7 9 5 5 5-5"/>,
  "chevron-right": <path d="m9 7 5 5-5 5"/>,
  close: <path d="M7 7l10 10M17 7 7 17"/>,
  external: <><path d="M14 5h5v5M19 5l-8 8"/><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></>,
  file: <><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5M9.5 13h5M9.5 17h5"/></>,
  folder: <path d="M3 7h7l2 2h9v10H3z"/>,
  home: <><path d="m3 11 9-7 9 7"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m4 17 5-5 4 4 2-2 5 5"/></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  projects: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></>,
  refresh: <><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/></>,
  send: <><path d="m5 12 14-7-4 14-3-6z"/><path d="m12 13 7-8"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.7-1L14.5 3h-5L9 6.1a8 8 0 0 0-1.7 1l-2.4-1-2 3.4L5 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a8 8 0 0 0 1.7 1l.4 3.1h5l.4-3.1a8 8 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z"/></>,
}

export function Icon({ name, className = "", ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return <svg {...props} className={`ui-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>
}
