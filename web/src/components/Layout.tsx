import { useEffect, useState, type ReactNode } from 'react';
import { Nav } from './Nav';
import { api } from '../lib/api';

export function Layout({ children }: { children: ReactNode }) {
  const [visitors, setVisitors] = useState<number | null>(null);
  const [build, setBuild] = useState<number | null>(null);

  // Layout mounts once per page load (not per in-app route change), so this
  // naturally counts "a visit" rather than every internal navigation.
  useEffect(() => {
    api.visitorCount().then((r) => {
      setVisitors(r.count);
      setBuild(r.build);
    }).catch(() => {});
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
            {visitors} Lifetime Visitor{visitors === 1 ? '' : 's'}
            {build !== null && ` - Build ${build}`}
          </span>
        )}
        <span className="inert">whatcd.wiki is a read-only archive and is not affiliated with what.cd. Nothing is downloadable.</span>
      </div>
    </>
  );
}
