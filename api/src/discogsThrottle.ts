// Discogs' documented rate limit for authenticated requests is 60/min,
// enforced per token -- i.e. per this whole process, not per request.
// Before this, nothing coordinated Discogs calls across callers: cover art
// lookups (cover.ts), video lookups (discogsRelease.ts, used by the
// regular release page and by what.tv), what.tv's live discovery loop,
// and what.tv's background pre-warmer could all fire Discogs requests at
// the same time with no shared awareness of each other. Individually each
// stayed under budget, but concurrently -- several visitors rolling
// "Next" on never-before-seen filter combos at once, while the
// pre-warmer's own tick lands in the same second -- they could easily
// stack past 60/min and start drawing 429s. Every Discogs HTTP call in
// the app is routed through this one serialized queue so that can't
// happen, no matter how many places are calling it or how concurrently.
let discogsQueue: Promise<void> = Promise.resolve();
const DISCOGS_MIN_SPACING_MS = 1050; // just over 1s between calls -> <60/min, with a small safety margin

export function throttleDiscogs<T>(fn: () => Promise<T>): Promise<T> {
  const run = discogsQueue.then(fn);
  discogsQueue = run.then(
    () => new Promise((resolve) => setTimeout(resolve, DISCOGS_MIN_SPACING_MS)),
    () => new Promise((resolve) => setTimeout(resolve, DISCOGS_MIN_SPACING_MS)),
  );
  return run;
}
