const icons = {
  overview: [["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }]],
  dashboard: [["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }]],
  alerts: [["path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" }], ["path", { d: "M10 21h4" }]],
  notifications: [["path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" }], ["path", { d: "M10 21h4" }]],
  notificationsActive: [["path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" }], ["path", { d: "M10 21h4" }], ["path", { d: "M4 4 2.5 2.5" }], ["path", { d: "m20 4 1.5-1.5" }]],
  pipelines: [["path", { d: "M6 4v5h12V4" }], ["path", { d: "M12 9v5" }], ["path", { d: "M5 14h14" }], ["rect", { x: 3, y: 14, width: 4, height: 6, rx: 1 }], ["rect", { x: 10, y: 14, width: 4, height: 6, rx: 1 }], ["rect", { x: 17, y: 14, width: 4, height: 6, rx: 1 }]],
  servers: [["rect", { x: 4, y: 4, width: 16, height: 5, rx: 1.5 }], ["rect", { x: 4, y: 15, width: 16, height: 5, rx: 1.5 }], ["path", { d: "M7 6.5h.01M7 17.5h.01M10 6.5h7M10 17.5h7M12 9v6" }]],
  dns: [["rect", { x: 4, y: 4, width: 16, height: 5, rx: 1.5 }], ["rect", { x: 4, y: 15, width: 16, height: 5, rx: 1.5 }], ["path", { d: "M7 6.5h.01M7 17.5h.01M10 6.5h7M10 17.5h7M12 9v6" }]],
  control: [["path", { d: "M4 12h4l2-6 4 12 2-6h4" }]],
  monitoring: [["path", { d: "M4 12h4l2-6 4 12 2-6h4" }]],
  tool: [["path", { d: "m14.7 6.3 3 3" }], ["path", { d: "M19 5a4 4 0 0 1-5.2 5.2L6.5 17.5a2.1 2.1 0 0 1-3-3l7.3-7.3A4 4 0 0 1 16 2" }]],
  speed: [["path", { d: "M4 14a8 8 0 1 1 16 0" }], ["path", { d: "m12 14 4-4" }], ["path", { d: "M8 21h8" }]],
  failed: [["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }], ["path", { d: "M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" }]],
  dangerous: [["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }], ["path", { d: "M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" }]],
  warning: [["path", { d: "M12 9v4" }], ["path", { d: "M12 17h.01" }], ["path", { d: "M10.3 3.9 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" }]],
  layers: [["path", { d: "m12 3 9 5-9 5-9-5 9-5Z" }], ["path", { d: "m3 12 9 5 9-5" }], ["path", { d: "m3 16 9 5 9-5" }]],
  satellite: [["path", { d: "M13 7 8 2 5 5l5 5" }], ["path", { d: "m8 8 8 8" }], ["path", { d: "m16 13 5 5-3 3-5-5" }], ["path", { d: "M3 14a7 7 0 0 0 7 7" }], ["path", { d: "M3 10a11 11 0 0 0 11 11" }]],
  terrain: [["path", { d: "m3 18 6-8 4 5 3-4 5 7H3Z" }], ["path", { d: "M9 10 7 7l-4 11" }]],
  vector: [["path", { d: "M4 17 9 7l6 10 5-8" }], ["circle", { cx: 4, cy: 17, r: 1.5 }], ["circle", { cx: 9, cy: 7, r: 1.5 }], ["circle", { cx: 15, cy: 17, r: 1.5 }], ["circle", { cx: 20, cy: 9, r: 1.5 }]],
  polyline: [["path", { d: "M4 17 9 7l6 10 5-8" }], ["circle", { cx: 4, cy: 17, r: 1.5 }], ["circle", { cx: 9, cy: 7, r: 1.5 }], ["circle", { cx: 15, cy: 17, r: 1.5 }], ["circle", { cx: 20, cy: 9, r: 1.5 }]],
  raster: [["path", { d: "M4 4h16v16H4z" }], ["path", { d: "M4 10h16M4 15h16M10 4v16M15 4v16" }]],
  grid_view: [["path", { d: "M4 4h16v16H4z" }], ["path", { d: "M4 10h16M4 15h16M10 4v16M15 4v16" }]],
  array: [["rect", { x: 4, y: 4, width: 5, height: 5, rx: 1 }], ["rect", { x: 15, y: 4, width: 5, height: 5, rx: 1 }], ["rect", { x: 4, y: 15, width: 5, height: 5, rx: 1 }], ["rect", { x: 15, y: 15, width: 5, height: 5, rx: 1 }]],
  apps: [["rect", { x: 4, y: 4, width: 5, height: 5, rx: 1 }], ["rect", { x: 15, y: 4, width: 5, height: 5, rx: 1 }], ["rect", { x: 4, y: 15, width: 5, height: 5, rx: 1 }], ["rect", { x: 15, y: 15, width: 5, height: 5, rx: 1 }]],
  style: [["circle", { cx: 12, cy: 12, r: 8 }], ["circle", { cx: 9, cy: 9, r: 1 }], ["circle", { cx: 15, cy: 9, r: 1 }], ["circle", { cx: 9, cy: 15, r: 1 }], ["path", { d: "M14 15h2" }]],
  palette: [["circle", { cx: 12, cy: 12, r: 8 }], ["circle", { cx: 9, cy: 9, r: 1 }], ["circle", { cx: 15, cy: 9, r: 1 }], ["circle", { cx: 9, cy: 15, r: 1 }], ["path", { d: "M14 15h2" }]],
  key: [["circle", { cx: 8, cy: 14, r: 4 }], ["path", { d: "m12 14 8-8" }], ["path", { d: "m17 7 2 2" }], ["path", { d: "m15 9 2 2" }]],
  config: [["path", { d: "M7 3h7l4 4v14H7z" }], ["path", { d: "M14 3v5h5" }], ["path", { d: "M9 13h6M9 17h4" }]],
  contract_edit: [["path", { d: "M7 3h7l4 4v14H7z" }], ["path", { d: "M14 3v5h5" }], ["path", { d: "M9 13h6M9 17h4" }]],
  env: [["path", { d: "M4 6h16" }], ["path", { d: "M4 12h16" }], ["path", { d: "M4 18h16" }], ["circle", { cx: 8, cy: 6, r: 2 }], ["circle", { cx: 16, cy: 12, r: 2 }], ["circle", { cx: 10, cy: 18, r: 2 }]],
  tune: [["path", { d: "M4 6h16" }], ["path", { d: "M4 12h16" }], ["path", { d: "M4 18h16" }], ["circle", { cx: 8, cy: 6, r: 2 }], ["circle", { cx: 16, cy: 12, r: 2 }], ["circle", { cx: 10, cy: 18, r: 2 }]],
  settings: [["circle", { cx: 12, cy: 12, r: 3 }], ["path", { d: "M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" }]],
  help: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M9.5 9a2.7 2.7 0 0 1 5 1.5c0 2-2.5 2.2-2.5 4" }], ["path", { d: "M12 18h.01" }]],
  image: [["rect", { x: 4, y: 5, width: 16, height: 14, rx: 2 }], ["circle", { cx: 9, cy: 10, r: 1.5 }], ["path", { d: "m4 17 5-5 4 4 2-2 5 5" }]],
  menuBook: [["path", { d: "M4 5.5A3.5 3.5 0 0 1 7.5 2H20v18H7.5A3.5 3.5 0 0 0 4 23V5.5Z" }], ["path", { d: "M4 5.5A3.5 3.5 0 0 0 .5 2H4" }]],
  secrets: [["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ["path", { d: "M8 11V8a4 4 0 0 1 8 0v3" }]],
  lock: [["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ["path", { d: "M8 11V8a4 4 0 0 1 8 0v3" }]],
  credentials: [["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ["circle", { cx: 9, cy: 12, r: 2 }], ["path", { d: "M14 10h4M14 14h3M6 17c1-2 5-2 6 0" }]],
  id_card: [["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ["circle", { cx: 9, cy: 12, r: 2 }], ["path", { d: "M14 10h4M14 14h3M6 17c1-2 5-2 6 0" }]],
  user: [["circle", { cx: 12, cy: 8, r: 4 }], ["path", { d: "M4 21c1.5-4 14.5-4 16 0" }]],
  person: [["circle", { cx: 12, cy: 8, r: 4 }], ["path", { d: "M4 21c1.5-4 14.5-4 16 0" }]],
  login: [["path", { d: "M10 17l5-5-5-5" }], ["path", { d: "M15 12H3" }], ["path", { d: "M14 4h5v16h-5" }]],
  console: [["path", { d: "m5 7 5 5-5 5" }], ["path", { d: "M12 17h7" }], ["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }]],
  terminal: [["path", { d: "m5 7 5 5-5 5" }], ["path", { d: "M12 17h7" }], ["rect", { x: 3, y: 4, width: 18, height: 16, rx: 2 }]],
  command: [["path", { d: "M8 8h8v8H8z" }], ["path", { d: "M4 4h4v4H4zM16 4h4v4h-4zM4 16h4v4H4zM16 16h4v4h-4z" }]],
  logout: [["path", { d: "M14 17l5-5-5-5" }], ["path", { d: "M19 12H8" }], ["path", { d: "M10 4H5v16h5" }]],
  play: [["path", { d: "M8 5v14l11-7-11-7Z" }]],
  pause: [["path", { d: "M8 5v14M16 5v14" }]],
  stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 1.5 }]],
  sync: [["path", { d: "M20 12a8 8 0 0 0-14-5" }], ["path", { d: "M6 3v4h4" }], ["path", { d: "M4 12a8 8 0 0 0 14 5" }], ["path", { d: "M18 21v-4h-4" }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  edit: [["path", { d: "M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" }], ["path", { d: "m14 8 3 3" }]],
  trash: [["path", { d: "M4 7h16" }], ["path", { d: "M10 11v6M14 11v6" }], ["path", { d: "M6 7l1 14h10l1-14" }], ["path", { d: "M9 7V4h6v3" }]],
  copy: [["rect", { x: 8, y: 8, width: 11, height: 11, rx: 2 }], ["path", { d: "M5 16H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }]],
  eye: [["path", { d: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" }], ["circle", { cx: 12, cy: 12, r: 3 }]],
  eyeOff: [["path", { d: "m3 3 18 18" }], ["path", { d: "M10.6 10.6A3 3 0 0 0 13.4 13.4" }], ["path", { d: "M9.9 5.2A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3.1 4.1" }], ["path", { d: "M6.6 6.6C3.6 8.6 2 12 2 12s3.5 7 10 7a10.8 10.8 0 0 0 5.4-1.4" }]],
  check: [["path", { d: "m5 12 4 4L19 6" }]],
  checkCircle: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "m8 12 3 3 5-6" }]],
  search: [["circle", { cx: 11, cy: 11, r: 7 }], ["path", { d: "m20 20-3.5-3.5" }]],
  chevronLeft: [["path", { d: "m15 18-6-6 6-6" }]],
  chevronRight: [["path", { d: "m9 18 6-6-6-6" }]],
  chevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
  arrowUp: [["path", { d: "m18 15-6-6-6 6" }]],
  arrowDown: [["path", { d: "m6 9 6 6 6-6" }]],
  close: [["path", { d: "M6 6l12 12M18 6 6 18" }]],
  disk: [["path", { d: "M5 4h14l2 5v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9l2-5Z" }], ["path", { d: "M7 15h10" }], ["path", { d: "M8 4v5h8V4" }]],
  folder: [["path", { d: "M3 7h7l2 3h9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" }]],
  home: [["path", { d: "m3 11 9-8 9 8" }], ["path", { d: "M5 10v10h14V10" }], ["path", { d: "M10 20v-6h4v6" }]],
  refresh: [["path", { d: "M20 12a8 8 0 0 0-14-5" }], ["path", { d: "M6 3v4h4" }], ["path", { d: "M4 12a8 8 0 0 0 14 5" }], ["path", { d: "M18 21v-4h-4" }]],
  markEmailRead: [["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ["path", { d: "m3 7 9 6 9-6" }], ["path", { d: "m9 15 2 2 4-5" }]],
  deleteSweep: [["path", { d: "M4 7h10" }], ["path", { d: "M7 7l1 12h6l1-8" }], ["path", { d: "M9 7V4h4v3" }], ["path", { d: "M16 13h5M17 17h3M18 9h4" }]],
  more: [["circle", { cx: 5, cy: 12, r: 1 }], ["circle", { cx: 12, cy: 12, r: 1 }], ["circle", { cx: 19, cy: 12, r: 1 }]],
  filter: [["path", { d: "M4 5h16l-6 7v6l-4 2v-8L4 5Z" }]],
  upload: [["path", { d: "M12 16V4" }], ["path", { d: "m7 9 5-5 5 5" }], ["path", { d: "M4 16v3h16v-3" }]],
  download: [["path", { d: "M12 4v12" }], ["path", { d: "m7 11 5 5 5-5" }], ["path", { d: "M4 20h16" }]],
  zip: [["path", { d: "M3 7h7l2 3h9v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" }], ["path", { d: "M13 10v8M16 10v8" }]],
  clock: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M12 7v5l3 3" }]],
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

function renderShape([tag, attrs], index) {
  const Tag = tag;
  return <Tag key={index} {...attrs} />;
}

export function Icon({ name, className = "", decorative = true, title, filled = false, style, ...props }) {
  const size = iconSize(className);
  const shapes = icons[name] || icons.overview;
  return (
    <svg
      aria-hidden={decorative && !title ? "true" : undefined}
      aria-label={!decorative || title ? title : undefined}
      className={`ptg-symbol ${className}`}
      data-filled={filled ? "true" : "false"}
      fill="none"
      height={size}
      role={!decorative || title ? "img" : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      style={{ width: size, height: size, ...style }}
      title={title}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {shapes.map(renderShape)}
    </svg>
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
