import {
  ArrowLeft, ArrowRight, Bell, Blocks, BookOpen, Check, CircleDashed, CircleHelp,
  CircleOff, Clock3, Copy, ExternalLink, Eye, FileCheck2, GitCompareArrows,
  KeyRound, LayoutDashboard, Link2, ListTodo, LogIn, LogOut, Menu, Minus, Monitor, Moon,
  Pause, Pencil, Play, Plug, Plus, RefreshCw, Save, ScrollText, Settings,
  ShieldCheck, Sun, Trash2, TriangleAlert, UserRound, UsersRound, Wrench, X,
} from 'lucide-react'
import './Icon.css'

const icons = {
  overview: LayoutDashboard, tasks: ListTodo, connections: Plug,
  extensions: Blocks, monitors: Bell, proposals: FileCheck2, clients: UsersRound,
  'mcp-tools': Wrench, audit: ScrollText, security: ShieldCheck,
  add: Plus, back: ArrowLeft, forward: ArrowRight, edit: Pencil, trash: Trash2,
  book: BookOpen, copy: Copy, check: Check, key: KeyRound, save: Save,
  refresh: RefreshCw, verify: ShieldCheck, play: Play, pause: Pause,
  settings: Settings, sun: Sun, moon: Moon, monitor: Monitor, user: UserRound,
  link: Link2, external: ExternalLink, view: Eye,
  close: X, menu: Menu, logout: LogOut, login: LogIn, compare: GitCompareArrows,
  help: CircleHelp, question: CircleHelp, warning: TriangleAlert,
  partial: CircleDashed, blocked: CircleOff, minus: Minus, clock: Clock3,
} as const

export type IconName = keyof typeof icons

/** Decorative icons accompany a visible label or an explicitly named control. */
export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  const Glyph = icons[name]
  return <Glyph size={size} strokeWidth={1.75} className={`ui-icon ${className}`.trim()}
    aria-hidden="true" focusable="false" data-icon={name} />
}
