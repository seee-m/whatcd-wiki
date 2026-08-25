import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Box } from '../components/Box';
import { TagPicker, type PickedTag } from '../components/TagPicker';
import { RELEASE_TYPES } from '../lib/releaseTypes';

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// "EP" stays as-is (an acronym reads worse lowercased-and-pluralized as
// "eps" than left alone), every other release type name is lowercased to
// sit naturally mid-sentence -- see buildSubtitle below.
function pluralizeType(name: string): string {
  const base = /^[A-Z]+$/.test(name) ? name : name.toLowerCase();
  if (/[^aeiou]y$/i.test(base)) return `${base.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(base)) return `${base}es`;
  return `${base}s`;
}

// Builds the live "what.tv — trance, electronic and goa albums and EPs
// from 1995-2005" preview next to the page title as the form fields are
// filled in, so the filters read back as a sentence instead of raw values.
function buildSubtitle(tagNames: string[], typeNames: string[], yearFrom: string, yearTo: string): string {
  const parts: string[] = [];
  const hasTypes = typeNames.length > 0;
  const noun = hasTypes ? joinWithAnd(typeNames.map(pluralizeType)) : 'releases';
  if (tagNames.length > 0) {
    parts.push(`${joinWithAnd(tagNames)} ${noun}`);
  } else if (hasTypes || yearFrom || yearTo) {
    parts.push(noun);
  }
  if (yearFrom && yearTo) parts.push(`from ${yearFrom}-${yearTo}`);
  else if (yearFrom) parts.push(`from ${yearFrom} onward`);
  else if (yearTo) parts.push(`up to ${yearTo}`);
  return parts.join(' ');
}

// what.tv's filter form. Builds an /api/tv/random query from the chosen
// tags/years/release types, and on success hands off to TvPlay.tsx with
// both the ids (for filtering) and human-readable names (for display --
// see the "Radio" box on that page) carried along in the URL.
export function TvSetup() {
  const navigate = useNavigate();
  const [tags, setTags] = useState<PickedTag[]>([]);
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [types, setTypes] = useState<Set<number>>(new Set());
  const [starting, setStarting] = useState(false);
  const [noResults, setNoResults] = useState(false);

  function toggleType(id: number) {
    const next = new Set(types);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTypes(next);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setStarting(true);
    setNoResults(false);
    const filterParams = new URLSearchParams();
    if (tags.length > 0) filterParams.set('tags', tags.map((t) => t.id).join(','));
    if (types.size > 0) filterParams.set('type', [...types].join(','));
    if (yearFrom) filterParams.set('yearFrom', yearFrom);
    if (yearTo) filterParams.set('yearTo', yearTo);
    try {
      const { id, poolHealthy, poolThreshold } = await api.tvRandom(filterParams);
      const displayParams = new URLSearchParams(filterParams);
      if (tags.length > 0) displayParams.set('tagNames', tags.map((t) => t.name).join(','));
      // poolHealthy/poolThreshold ride along as router state (not URL
      // params) since they're an ephemeral fact about this one roll, not
      // a filter -- TvPlay.tsx reads them to show a "this might be slow"
      // warning on the first release, same as it does after every "Next".
      navigate(`/tv/${id}?${displayParams.toString()}`, { state: { poolHealthy, poolThreshold } });
    } catch {
      setNoResults(true);
    } finally {
      setStarting(false);
    }
  }

  if (noResults) {
    return (
      <div className="tv-setup-column">
        <h2>what.tv</h2>
        <Box title="what.tv" collapsible={false}>
          <p>Oops! No results for your search.</p>
          <p className="action-row">
            <button type="button" className="dice-button tv-start-button" onClick={() => setNoResults(false)}>
              Try again
            </button>
          </p>
        </Box>
      </div>
    );
  }

  const subtitle = buildSubtitle(
    tags.map((t) => t.name),
    RELEASE_TYPES.filter((t) => types.has(t.id)).map((t) => t.name),
    yearFrom,
    yearTo,
  );

  return (
    <div className="tv-setup-column">
      <h2>
        what.tv
        {subtitle && <> &mdash; {subtitle}</>}
      </h2>
      <form onSubmit={onSubmit}>
        <Box title="what.tv" collapsible={false}>
          <p>Pick some tags, and a year range / release type (optional) and enjoy your trip!</p>
        </Box>

        <Box title="Tags (matches any selected)" collapsible={false}>
          <TagPicker selected={tags} onChange={setTags} />
        </Box>

        <Box title="Year range" collapsible={false}>
          <span className="tv-year-range">
            <input
              type="number"
              min={1920}
              max={2017}
              value={yearFrom}
              onChange={(e) => setYearFrom(e.target.value)}
              placeholder="From, e.g. 1990"
            />
            <input
              type="number"
              min={1920}
              max={2017}
              value={yearTo}
              onChange={(e) => setYearTo(e.target.value)}
              placeholder="To, e.g. 1999"
            />
          </span>
        </Box>

        <Box title="Release types" collapsible={false}>
          <span className="tv-type-list">
            {RELEASE_TYPES.map((t) => (
              <label key={t.id}>
                <input type="checkbox" checked={types.has(t.id)} onChange={() => toggleType(t.id)} /> {t.name}
              </label>
            ))}
          </span>
        </Box>

        <p className="action-row">
          <button type="submit" className="dice-button tv-start-button" disabled={starting}>
            {starting ? 'Finding a release…' : 'Start'}
          </button>
        </p>
      </form>
    </div>
  );
}
