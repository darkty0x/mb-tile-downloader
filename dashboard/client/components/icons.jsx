const paths = {
  overview: [
    <path key="a" d="M4 4h7v7H4z" />,
    <path key="b" d="M13 4h7v7h-7z" />,
    <path key="c" d="M4 13h7v7H4z" />,
    <path key="d" d="M13 13h7v7h-7z" />,
  ],
  alerts: [<path key="a" d="M6 8a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9Z" />, <path key="b" d="M10 21h4" />],
  pipelines: [<path key="a" d="M5 7h4v4H5zM15 13h4v4h-4z" />, <path key="b" d="M9 9h3a3 3 0 0 1 3 3v1M15 15h-3a3 3 0 0 1-3-3v-1" />],
  servers: [
    <rect key="a" x="4" y="4" width="16" height="6" rx="2" />,
    <rect key="b" x="4" y="14" width="16" height="6" rx="2" />,
    <path key="c" d="M8 7h.01M8 17h.01M12 7h4M12 17h4" />,
  ],
  control: [<path key="a" d="M4 13h4l3-8 4 14 3-6h2" />],
  speed: [<path key="a" d="M5 19a8 8 0 1 1 14 0" />, <path key="b" d="m12 13 4-4" />],
  warning: [
    <path key="a" d="M12 9v4" />,
    <path key="b" d="M12 17h.01" />,
    <path key="c" d="M10.3 4.8 2.7 18a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.8a2 2 0 0 0-3.4 0Z" />,
  ],
  layers: [<path key="a" d="m12 3 9 5-9 5-9-5 9-5Z" />, <path key="b" d="m3 13 9 5 9-5" />, <path key="c" d="m3 18 9 5 9-5" />],
  satellite: [<circle key="a" cx="12" cy="12" r="3.2" />, <path key="b" d="M12 4v3M12 17v3M4 12h3M17 12h3" />, <path key="c" d="m6.5 6.5 2.1 2.1M15.4 15.4l2.1 2.1M17.5 6.5l-2.1 2.1M8.6 15.4l-2.1 2.1" />],
  terrain: [<path key="a" d="M3 18 8.5 7l4 7 2.5-4 6 8Z" />, <path key="b" d="M8.5 7 11 18M15 10l-1 8" />],
  vector: [<circle key="a" cx="6" cy="17" r="2" />, <circle key="b" cx="12" cy="7" r="2" />, <circle key="c" cx="18" cy="17" r="2" />, <path key="d" d="M7.2 15.4 10.8 8.7M13.2 8.7l3.6 6.7M8 17h8" />],
  raster: [<path key="a" d="M4 5h16v14H4z" />, <path key="b" d="M4 10h16M4 15h16M9 5v14M15 5v14" />],
  array: [<path key="a" d="M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z" />, <path key="b" d="M10 7.5h4M10 16.5h4M7.5 10v4M16.5 10v4" />],
  style: [<path key="a" d="M5 18c4-1 6-4 6-8 0-2 1.5-4 4-4 2.2 0 4 1.8 4 4 0 5-5 9-11 9H5Z" />, <path key="b" d="M7 17c1.6-1.7 2-3.5 2-6" />, <circle key="c" cx="15" cy="10" r="1" />],
  key: [<circle key="a" cx="7.5" cy="14.5" r="3.5" />, <path key="b" d="M10 12 21 1M15 7l2 2M18 4l2 2" />],
  config: [<path key="a" d="M6 3h8l4 4v14H6z" />, <path key="b" d="M14 3v5h5" />, <path key="c" d="M9 13h6M9 17h6" />],
  env: [<path key="a" d="M5 6h14M5 12h14M5 18h14" />, <circle key="b" cx="9" cy="6" r="2" />, <circle key="c" cx="15" cy="12" r="2" />, <circle key="d" cx="11" cy="18" r="2" />],
  settings: [<path key="a" d="M5 6h6M15 6h4" />, <path key="b" d="M5 12h3M12 12h7" />, <path key="c" d="M5 18h8M17 18h2" />, <circle key="d" cx="13" cy="6" r="2" />, <circle key="e" cx="10" cy="12" r="2" />, <circle key="f" cx="15" cy="18" r="2" />],
  secrets: [<rect key="a" x="5" y="10" width="14" height="10" rx="2" />, <path key="b" d="M8 10V7a4 4 0 0 1 8 0v3" />],
  credentials: [<rect key="a" x="4" y="5" width="16" height="14" rx="2.5" />, <path key="b" d="M8 10h5M8 14h3" />, <circle key="c" cx="16.5" cy="13.5" r="1.5" />, <path key="d" d="m18 15 2 2M20 17l-1.5 1.5" />],
  console: [<path key="a" d="m5 7 5 5-5 5" />, <path key="b" d="M12 17h7" />],
  bell: [<path key="a" d="M6 8a6 6 0 0 1 12 0v4.5l2 3.5H4l2-3.5Z" />, <path key="b" d="M10 20h4" />],
  command: [<path key="a" d="M8 8H6a3 3 0 1 1 3-3v2h6V5a3 3 0 1 1 3 3h-2v8h2a3 3 0 1 1-3 3v-2H9v2a3 3 0 1 1-3-3h2z" />],
  logout: [<path key="a" d="M14 8V5a2 2 0 0 0-2-2H5v18h7a2 2 0 0 0 2-2v-3" />, <path key="b" d="M10 12h11m-3-3 3 3-3 3" />],
  play: [<path key="a" d="M8 5v14l11-7Z" />],
  pause: [<path key="a" d="M7 5h4v14H7zM15 5h4v14h-4z" />],
  stop: [<rect key="a" x="7" y="7" width="10" height="10" rx="1.5" />],
  sync: [<path key="a" d="M20 7h-5.5A6 6 0 0 0 4 11" />, <path key="b" d="M4 5v6h6" />, <path key="c" d="M4 17h5.5A6 6 0 0 0 20 13" />, <path key="d" d="M20 19v-6h-6" />],
  plus: [<path key="a" d="M12 5v14M5 12h14" />],
  edit: [<path key="a" d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z" />, <path key="b" d="m13 6 5 5" />],
  trash: [<path key="a" d="M4 7h16" />, <path key="b" d="M10 11v6M14 11v6" />, <path key="c" d="M6 7l1 14h10l1-14" />, <path key="d" d="M9 7V4h6v3" />],
  copy: [<path key="a" d="M8 8h11v11H8z" />, <path key="b" d="M5 16H4V5h11v1" />],
  eye: [<path key="a" d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />, <circle key="b" cx="12" cy="12" r="2.6" />],
  eyeOff: [<path key="a" d="M3 3l18 18" />, <path key="b" d="M10.6 5.2A10.8 10.8 0 0 1 12 5c6 0 9.5 7 9.5 7a16.4 16.4 0 0 1-2.4 3.2" />, <path key="c" d="M6.6 6.7C3.9 8.5 2.5 12 2.5 12s3.5 7 9.5 7a9.8 9.8 0 0 0 4.4-1" />, <path key="d" d="M9.8 9.8a2.6 2.6 0 0 0 3.5 3.5" />],
  check: [<path key="a" d="m5 12 4 4L19 6" />],
  search: [<circle key="a" cx="11" cy="11" r="6" />, <path key="b" d="m16 16 4 4" />],
  chevronLeft: [<path key="a" d="m15 18-6-6 6-6" />],
  chevronRight: [<path key="a" d="m9 18 6-6-6-6" />],
  chevronDown: [<path key="a" d="m6 9 6 6 6-6" />],
  close: [<path key="a" d="M7 7l10 10M17 7 7 17" />],
  disk: [<path key="a" d="M5 6h14l2 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4l2-8Z" />, <path key="b" d="M6 14h12M8 17h.01M12 17h4" />],
  home: [<path key="a" d="M4 11.5 12 5l8 6.5" />, <path key="b" d="M6.5 10.5V20h11v-9.5" />, <path key="c" d="M10 20v-5h4v5" />],
  refresh: [<path key="a" d="M20 12a8 8 0 0 1-14.7 4.4" />, <path key="b" d="M4 17v-5h5" />, <path key="c" d="M4 12a8 8 0 0 1 14.7-4.4" />, <path key="d" d="M20 7v5h-5" />],
  more: [<circle key="a" cx="6" cy="12" r="1.4" />, <circle key="b" cx="12" cy="12" r="1.4" />, <circle key="c" cx="18" cy="12" r="1.4" />],
  filter: [<path key="a" d="M4 6h16l-6 7v5l-4 2v-7z" />],
  upload: [<path key="a" d="M12 16V4" />, <path key="b" d="m7 9 5-5 5 5" />, <path key="c" d="M5 16v3h14v-3" />],
  download: [<path key="a" d="M12 4v12" />, <path key="b" d="m7 11 5 5 5-5" />, <path key="c" d="M5 20h14" />],
  clock: [<circle key="a" cx="12" cy="12" r="8" />, <path key="b" d="M12 8v5l3 2" />],
};

export function Icon({ name, className = "", decorative = true, title, ...props }) {
  return (
    <svg
      aria-hidden={decorative && !title ? "true" : undefined}
      className={className}
      fill="none"
      role={!decorative || title ? "img" : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      vectorEffect="non-scaling-stroke"
      viewBox="0 0 24 24"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {paths[name] || paths.overview}
    </svg>
  );
}

export function LogoMark() {
  return (
    <span aria-hidden="true" className="ptg-wordmark shrink-0">PTG</span>
  );
}
