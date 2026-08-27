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
        <span className="inert">
          whatcd.wiki is a read-only archive. This site is not part of what.cd. This site has no
          connection to the labels, groups, or artists named here. Cover art, YouTube links, and
          artist photos supplied via the Discogs, iTunes, MusicBrainz, and Wikipedia APIs. No
          media is stored on this server. Artist bios cached via Wikipedia. This site is built
          from the open-source what.cd &ldquo;goodbye&rdquo; release &ndash; available on
          archive.org. This site&apos;s source code is dedicated to the public domain (CC0).
          Content and data displayed from the sources credited above remain under their
          respective terms. Thank you to all who share free, open information for making this
          project possible. &#9774;
        </span>
      </div>
    </>
  );
}
