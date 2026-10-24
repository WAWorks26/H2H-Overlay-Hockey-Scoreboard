'use client';

import { usePathname } from 'next/navigation';

// Routes that render without the marketing nav bar and footer:
// the control panel and the OBS overlay.
const BARE_ROUTE_PREFIXES = ['/control', '/view'];

export default function SiteChrome({
  nav,
  footer,
  children,
}: {
  nav: React.ReactNode;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname() || '';
  const bare = BARE_ROUTE_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`));

  if (bare) return <>{children}</>;

  return (
    <>
      {nav}
      <main className="flex-1">{children}</main>
      {footer}
    </>
  );
}
