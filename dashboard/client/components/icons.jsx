const paths = {
  overview: [
    <path key="a" d="M4 4h7v7H4z" />,
    <path key="b" d="M13 4h7v7h-7z" />,
    <path key="c" d="M4 13h7v7H4z" />,
    <path key="d" d="M13 13h7v7h-7z" />,
  ],
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
    <svg aria-hidden="true" className="h-11 w-12 shrink-0 overflow-visible" viewBox="0 0 112 82">
      <defs>
        <linearGradient id="ptg-mark-blue" x1="5" x2="92" y1="12" y2="70" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0b73d9" />
          <stop offset="1" stopColor="#064da8" />
        </linearGradient>
        <linearGradient id="ptg-mark-violet" x1="39" x2="87" y1="28" y2="54" gradientUnits="userSpaceOnUse">
          <stop stopColor="#bbc3ff" />
          <stop offset="1" stopColor="#7f8fea" />
        </linearGradient>
      </defs>
      <path
        d="M91.6 12.6C69.4 1 35.6 4.4 15.7 23.3-8.8 46.6 8.3 72 42.8 76.3c18.7 2.3 36.4-1.7 49.2-10.4-17.1 3.6-39.7 2.4-57-4.4C8.2 50.9 9.9 30.1 31.2 18.7c15-8 39.4-10.7 60.4-6.1Z"
        fill="url(#ptg-mark-blue)"
      />
      <path
        d="M78.5 23.3C62 13.7 38.7 16 26.4 29.1 12.9 43.1 25.6 60 49.4 60.3c15.3.2 29.4-5.3 39.2-14.1-11.1 3.8-26.2 3.3-39.5-1.9-16.7-6.5-20.7-19.1-8.6-25.1 10-4.9 25.7-3.7 38 4.1Z"
        fill="url(#ptg-mark-blue)"
      />
      <path
        d="M39.1 51.2c12.7 8.7 32.5 8.5 42.9-.8 9.9-8.9 4-23.7-13.6-32.3 9.3 7.5 11.4 16.7 4.9 23.1-7.6 7.5-22.1 10.2-34.2 10Z"
        fill="url(#ptg-mark-violet)"
      />
    </svg>
  );
}
