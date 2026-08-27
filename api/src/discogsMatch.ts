// Shared by discogsRelease.ts and cover.ts -- both fire a Discogs full-text
// search and can't trust its relevance ranking blindly (it has returned a
// release sharing no resemblance at all with the query, see
// discogsRelease.ts). Compacted (whitespace stripped, not just collapsed)
// so punctuation-only spelling differences ("Run-D.M.C." vs "RUN DMC")
// still resemble each other.
export function compact(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function resembles(query: string, candidate: string): boolean {
  const a = compact(query);
  const b = compact(candidate);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}
