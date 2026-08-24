import type { ReactNode } from 'react';
import { Nav } from './Nav';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav />
      <div id="content">
        <div id="wrapper" className="thin">
          {children}
        </div>
      </div>
      <div id="footer">
        <span className="inert">whatcd.wiki is a read-only archive and is not affiliated with what.cd. Nothing is downloadable.</span>
      </div>
    </>
  );
}
