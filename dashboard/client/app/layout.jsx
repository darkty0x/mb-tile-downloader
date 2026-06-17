import "./globals.css";

export const metadata = {
  title: "PTG 관리체계",
  description: "PTG 관리체계",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
