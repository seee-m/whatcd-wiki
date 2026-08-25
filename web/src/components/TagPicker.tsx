import { useEffect, useState } from 'react';
import { api, type TagListItem } from '../lib/api';

export interface PickedTag {
  id: number;
  name: string;
}

// Multi-tag autocomplete: type to search (reuses the same /api/tags the
// Tags browse page uses), click a suggestion to add it as a chip. Used by
// what.tv's setup form (pages/TvSetup.tsx) to build a "match any of these
// tags" filter -- there's no existing multi-select input anywhere else in
// the app to reuse.
export function TagPicker({ selected, onChange }: { selected: PickedTag[]; onChange: (tags: PickedTag[]) => void }) {
  const [q, setQ] = useState('');
  const [suggestions, setSuggestions] = useState<TagListItem[]>([]);

  useEffect(() => {
    if (q.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    api.tags(new URLSearchParams({ q, sort: 'uses' })).then((r) => {
      if (!cancelled) setSuggestions(r.items);
    });
    return () => {
      cancelled = true;
    };
  }, [q]);

  function addTag(t: TagListItem) {
    if (!selected.some((s) => s.id === t.id)) onChange([...selected, { id: t.id, name: t.name }]);
    setQ('');
    setSuggestions([]);
  }

  function removeTag(id: number) {
    onChange(selected.filter((s) => s.id !== id));
  }

  const visibleSuggestions = suggestions.filter((s) => !selected.some((sel) => sel.id === s.id));

  return (
    <div className="tag-picker">
      {selected.length > 0 && (
        <div className="tags tag-picker-chips">
          {selected.map((t) => (
            <a
              key={t.id}
              href="#"
              onClick={(e) => {
                e.preventDefault();
                removeTag(t.id);
              }}
            >
              {t.name} &times;
            </a>
          ))}
        </div>
      )}
      <div className="tag-picker-input">
        <input
          type="text"
          value={q}
          placeholder="Search tags&hellip; (min 2 characters)"
          onChange={(e) => setQ(e.target.value)}
        />
        {visibleSuggestions.length > 0 && (
          <ul className="tag-picker-suggestions">
            {visibleSuggestions.map((s) => (
              <li key={s.id}>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    addTag(s);
                  }}
                >
                  {s.name} ({s.uses})
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
