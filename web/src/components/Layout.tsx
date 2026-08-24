import { useEffect, useState, type ReactNode } from 'react';
import { Nav } from './Nav';
import { api } from '../lib/api';

export function Layout({ children }: { children: ReactNode }) {
  const [visitors, setVisitors] = useState<number | null>(null);

  // Layout mounts once per page load (not per in-app route change), so this
  // naturally counts "a visit" rather than every internal navigation.
  useEffect(() => {
    api.visitorsToday().then((r) => setVisitors(r.count)).catch(() => {});
  }, []);

  return (
    <>
      <Nav />
      <div id="content">
        <div id="wrapper" className="thin">
          {children}
        </div>
      </div>
      <div id="footer">
        {visitors !== null && (
          <span className="visitor-count inert">
            {visitors} visitor{visitors === 1 ? '' : 's'} today
          </span>
        )}
        <span className="inert">whatcd.wiki is a read-only archive and is not affiliated with what.cd. Nothing is downloadable.</span>
      </div>
    </>
  );
}
