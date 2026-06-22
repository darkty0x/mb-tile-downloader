import {
  Activity,
  Archive,
  ArrowDown,
  ArrowUp,
  Bell,
  BellRing,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  Clock,
  Copy,
  Database,
  Download,
  Eye,
  EyeOff,
  FileCog,
  FileText,
  Filter,
  Folder,
  Gauge,
  Grid3X3,
  HardDrive,
  House,
  IdCard,
  Image,
  KeyRound,
  Layers,
  LayoutDashboard,
  ListX,
  LockKeyhole,
  LogIn,
  LogOut,
  MailCheck,
  Map,
  MonitorCog,
  MoreHorizontal,
  Mountain,
  Palette,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Satellite,
  Search,
  Server,
  ServerCog,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Spline,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  Wifi,
  WifiOff,
  Workflow,
  Wrench,
  X,
} from "lucide-react";

const icons = {
  overview: LayoutDashboard,
  dashboard: LayoutDashboard,
  alerts: Bell,
  bell: Bell,
  notifications: Bell,
  notificationsActive: BellRing,
  pipelines: Workflow,
  servers: Server,
  dns: ServerCog,
  control: Activity,
  monitoring: Activity,
  tool: Wrench,
  speed: Gauge,
  failed: TriangleAlert,
  dangerous: TriangleAlert,
  warning: TriangleAlert,
  layers: Layers,
  satellite: Satellite,
  terrain: Mountain,
  vector: Spline,
  polyline: Spline,
  raster: Grid3X3,
  grid_view: Grid3X3,
  array: Grid3X3,
  apps: Grid3X3,
  style: Palette,
  palette: Palette,
  key: KeyRound,
  config: FileCog,
  configs: FileCog,
  contract_edit: FileCog,
  env: SlidersHorizontal,
  tune: SlidersHorizontal,
  settings: Settings,
  help: CircleHelp,
  image: Image,
  menuBook: BookOpen,
  secrets: LockKeyhole,
  lock: LockKeyhole,
  credentials: IdCard,
  id_card: IdCard,
  user: User,
  person: User,
  login: LogIn,
  console: Terminal,
  terminal: Terminal,
  command: Terminal,
  logout: LogOut,
  play: Play,
  pause: Pause,
  stop: Square,
  sync: RefreshCw,
  plus: Plus,
  edit: Pencil,
  trash: Trash2,
  copy: Copy,
  eye: Eye,
  eyeOff: EyeOff,
  check: Check,
  checkCircle: CircleCheck,
  search: Search,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  close: X,
  disk: HardDrive,
  folder: Folder,
  home: House,
  refresh: RefreshCw,
  markEmailRead: MailCheck,
  deleteSweep: ListX,
  more: MoreHorizontal,
  filter: Filter,
  upload: Upload,
  download: Download,
  zip: Archive,
  clock: Clock,
  tiles: Map,
  active: ShieldCheck,
  healthy: ShieldCheck,
  critical: TriangleAlert,
  offline: WifiOff,
  running: Activity,
  storagePressure: HardDrive,
  throughput: Gauge,
  serversOnline: Server,
  activeJobs: Workflow,
  failedJobs: TriangleAlert,
  resourceAlerts: Bell,
  mapbox_token: KeyRound,
  credential: IdCard,
  machine: MonitorCog,
  events: Bell,
  database: Database,
  wifi: Wifi,
  wifiOff: WifiOff,
  file: FileText,
};

function iconSize(className) {
  if (/\b(?:h|w)-3(?:\s|$)/.test(className)) return 12;
  if (/\b(?:h|w)-3\.5(?:\s|$)/.test(className)) return 14;
  if (/\b(?:h|w)-4(?:\s|$)/.test(className)) return 16;
  if (/\b(?:h|w)-5(?:\s|$)/.test(className)) return 20;
  if (/\b(?:h|w)-6(?:\s|$)/.test(className)) return 24;
  if (/\b(?:h|w)-7(?:\s|$)/.test(className)) return 28;
  if (/\b(?:h|w)-8(?:\s|$)/.test(className)) return 32;
  return 20;
}

export function Icon({ name, className = "", decorative = true, title, filled = false, style, ...props }) {
  const size = iconSize(className);
  const IconComponent = icons[name] || icons.overview;

  return (
    <IconComponent
      aria-hidden={decorative && !title ? "true" : undefined}
      aria-label={!decorative || title ? title : undefined}
      className={`ptg-symbol ${className}`}
      data-filled={filled ? "true" : "false"}
      fill={filled ? "currentColor" : "none"}
      focusable="false"
      role={!decorative || title ? "img" : undefined}
      size={size}
      strokeWidth={2}
      style={{ width: size, height: size, ...style }}
      {...props}
    />
  );
}

export function LogoMark({ variant = "rail", style } = {}) {
  const src = variant === "login" ? "/brand/ptg-primary-dark.svg" : "/brand/ptg-primary-rail.svg";
  return (
    <img
      alt="PTG"
      className="ptg-brand-logo shrink-0"
      decoding="async"
      data-variant={variant}
      style={style}
      src={src}
    />
  );
}
