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
  check: [<path key="a" d="m5 12 4 4L19 6" />],
  search: [<circle key="a" cx="11" cy="11" r="6" />, <path key="b" d="m16 16 4 4" />],
  close: [<path key="a" d="M7 7l10 10M17 7 7 17" />],
  disk: [<path key="a" d="M5 6h14l2 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4l2-8Z" />, <path key="b" d="M6 14h12M8 17h.01M12 17h4" />],
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
    <svg aria-hidden="true" className="h-11 w-11 shrink-0 overflow-visible ptg-logo-shadow" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="ptg-mark-blue" x1="10" x2="48" y1="14" y2="50" gradientUnits="userSpaceOnUse">
          <stop stopColor="#34d5ff" />
          <stop offset="1" stopColor="#0b7cff" />
        </linearGradient>
        <linearGradient id="ptg-mark-red" x1="8" x2="56" y1="22" y2="44" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ff4c56" />
          <stop offset="1" stopColor="#fb123b" />
        </linearGradient>
      </defs>
      <path
        className="brand-orbit-blue"
        d="M31.9 9.4c13.7 0 24.9 6 24.9 13.4S45.6 36.2 31.9 36.2 7 30.2 7 22.8 18.2 9.4 31.9 9.4Zm0 5.9c-10.6 0-19.2 3.4-19.2 7.5s8.6 7.5 19.2 7.5 19.2-3.4 19.2-7.5-8.6-7.5-19.2-7.5Z"
        fill="url(#ptg-mark-blue)"
      />
      <path
        className="brand-orbit-red"
        d="M55.5 25.3c-2.8-5.4-13.2-9.3-25.3-9.3-14.7 0-26.6 5.2-26.6 11.6 0 4.5 5.9 8.4 14.5 10.2C8.6 37 1.9 32.5 1.9 27.2c0-7.4 12.8-13.4 28.6-13.4 13.2 0 24.3 4.2 27.5 9.9Z"
        fill="url(#ptg-mark-red)"
      />
      <text x="17" y="36.5" fill="#35d4ff" fontFamily="Inter, Arial Black, Arial, sans-serif" fontSize="14" fontWeight="900" letterSpacing="-0.6">PTG</text>
    </svg>
  );
}
