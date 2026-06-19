const symbols = {
  overview: "dashboard",
  alerts: "notifications",
  pipelines: "account_tree",
  servers: "dns",
  control: "monitoring",
  tool: "build",
  speed: "speed",
  failed: "dangerous",
  warning: "warning",
  layers: "layers",
  satellite: "satellite_alt",
  terrain: "terrain",
  vector: "polyline",
  raster: "grid_view",
  array: "apps",
  style: "palette",
  key: "key",
  config: "contract_edit",
  env: "tune",
  settings: "settings",
  help: "help",
  image: "image",
  menuBook: "menu_book",
  secrets: "lock",
  credentials: "id_card",
  user: "person",
  lock: "lock",
  login: "login",
  console: "terminal",
  bell: "notifications",
  command: "keyboard_command_key",
  logout: "logout",
  play: "play_arrow",
  pause: "pause",
  stop: "stop",
  sync: "sync",
  plus: "add",
  edit: "edit",
  trash: "delete",
  copy: "content_copy",
  eye: "visibility",
  eyeOff: "visibility_off",
  check: "check",
  checkCircle: "check_circle",
  search: "search",
  chevronLeft: "chevron_left",
  chevronRight: "chevron_right",
  chevronDown: "keyboard_arrow_down",
  close: "close",
  disk: "hard_drive",
  home: "home",
  refresh: "refresh",
  notificationsActive: "notifications_active",
  markEmailRead: "mark_email_read",
  deleteSweep: "delete_sweep",
  more: "more_horiz",
  filter: "filter_alt",
  upload: "cloud_upload",
  download: "download",
  zip: "folder_zip",
  clock: "schedule",
};

function iconSize(className) {
  if (/\b(?:h|w)-3(?:\s|$)/.test(className)) return "12px";
  if (/\b(?:h|w)-3\.5(?:\s|$)/.test(className)) return "14px";
  if (/\b(?:h|w)-4(?:\s|$)/.test(className)) return "16px";
  if (/\b(?:h|w)-5(?:\s|$)/.test(className)) return "20px";
  if (/\b(?:h|w)-6(?:\s|$)/.test(className)) return "24px";
  if (/\b(?:h|w)-7(?:\s|$)/.test(className)) return "28px";
  if (/\b(?:h|w)-8(?:\s|$)/.test(className)) return "32px";
  return "20px";
}

export function Icon({ name, className = "", decorative = true, title, filled = false, style, ...props }) {
  return (
    <span
      aria-hidden={decorative && !title ? "true" : undefined}
      aria-label={!decorative || title ? title : undefined}
      className={`material-symbols-rounded ptg-symbol ${className}`}
      data-filled={filled ? "true" : "false"}
      role={!decorative || title ? "img" : undefined}
      style={{ fontSize: iconSize(className), ...style }}
      title={title}
      {...props}
    >
      {symbols[name] || symbols.overview}
    </span>
  );
}

export function LogoMark() {
  return (
    <img
      alt="PTG"
      className="ptg-brand-logo shrink-0"
      decoding="async"
      src="/brand/ptg-primary-rail.svg"
    />
  );
}
