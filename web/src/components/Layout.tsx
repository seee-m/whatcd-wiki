import { useEffect, useState, type ReactNode } from 'react';
import { Nav } from './Nav';

export function Layout({ children }: { children: ReactNode }) {
  const [viewCount, setViewCount] = useState<number | null>(null);

  useEffect(() => {
    // Rendered locally rather than embedding GoatCounter's own counter
    // image -- its `style`/`no_branding` query params are documented but
    // don't actually change the rendered SVG (confirmed via curl), so the
    // only way to match this site's look is to pull the raw number from
    // its JSON endpoint (CORS-open) and style it ourselves.
    fetch('https://whatcdwiki.goatcounter.com/counter/TOTAL.json')
      .then((r) => r.json())
      .then((data: { count: string }) => setViewCount(Number(data.count)))
      .catch(() => {});
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
        <div className="footer-content">
          {viewCount !== null && <div className="site-counter">{viewCount.toLocaleString()} site views</div>}
          <br />
          <span className="inert">
            Thank you to all who share free, open information for making this project possible.{' '}
            &#9774;
          </span>
        </div>
      </div>
    </>
  );
}
