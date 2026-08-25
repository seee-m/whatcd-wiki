// Mirrors the real Gazelle $ReleaseTypes mapping (classes/config.template)
// -- see api/src/db.ts RELEASE_TYPES, which the /api/torrents and
// /api/tv/random `type` filters match against.
export const RELEASE_TYPES = [
  { id: 1, name: 'Album' },
  { id: 3, name: 'Soundtrack' },
  { id: 5, name: 'EP' },
  { id: 6, name: 'Anthology' },
  { id: 7, name: 'Compilation' },
  { id: 9, name: 'Single' },
  { id: 11, name: 'Live album' },
  { id: 13, name: 'Remix' },
  { id: 14, name: 'Bootleg' },
  { id: 15, name: 'Interview' },
  { id: 16, name: 'Mixtape' },
  { id: 21, name: 'Unknown' },
];
