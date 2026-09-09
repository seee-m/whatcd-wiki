import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

declare global {
  interface Window {
    goatcounter?: {
      count: (opts?: { path?: string; title?: string; referrer?: string }) => void;
    };
  }
}

// GoatCounter's script only auto-counts the initial page load (disabled via
// no_onload in index.html); client-side route changes need an explicit call.
export function Analytics() {
  const location = useLocation();

  useEffect(() => {
    window.goatcounter?.count?.({ path: location.pathname + location.search });
  }, [location.pathname, location.search]);

  return null;
}
