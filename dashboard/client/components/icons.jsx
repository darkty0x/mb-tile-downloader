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
  secrets: [<rect key="a" x="5" y="10" width="14" height="10" rx="2" />, <path key="b" d="M8 10V7a4 4 0 0 1 8 0v3" />],
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

export function Icon({ name, className = "", decorative = true }) {
  return (
    <svg
      aria-hidden={decorative ? "true" : undefined}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      {paths[name] || paths.overview}
    </svg>
  );
}

export function LogoMark() {
  return (
    <svg aria-hidden="true" className="h-9 w-[72px] overflow-visible" viewBox="0 0 180 92">
      <ellipse className="brand-orbit-blue" cx="90" cy="46" rx="78" ry="22" stroke="#12aeea" strokeLinecap="round" strokeWidth="3.5" fill="none" transform="rotate(-22 90 46)" />
      <ellipse className="brand-orbit-red" cx="88" cy="47" rx="73" ry="20" stroke="#ff2535" strokeLinecap="round" strokeWidth="8" fill="none" transform="rotate(20 88 47)" />
      <text x="32" y="62" fill="#14aee5" fontFamily="Impact, Arial Black, sans-serif" fontSize="44" fontWeight="900" letterSpacing="0">
        PTG
      </text>
    </svg>
  );
}
