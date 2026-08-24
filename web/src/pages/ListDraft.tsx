import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Box } from '../components/Box';
import { getDraft, removeFromDraft, clearDraft, type DraftItem } from '../lib/listDraft';

export function ListDraft() {
  const navigate = useNavigate();
  const [items, setItems] = useState<DraftItem[]>([]);
  const [categories, setCategories] = useState<{ id: number; name: string }[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(getDraft());
    api.collageCategories().then(setCategories);
  }, []);

  function remove(id: number) {
    removeFromDraft(id);
    setItems(getDraft());
  }

  async function share() {
    if (!title.trim() || items.length === 0) return;
    const confirmed = window.confirm(
      'Are you sure you want to create this list? It will no longer be editable. Keep the link safe, it is your only way to access this list!',
    );
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      const { id } = await api.createList({
        title: title.trim(),
        description: description.trim() || undefined,
        categoryId,
        releaseIds: items.map((i) => i.id),
      });
      clearDraft();
      navigate(`/lists/${id}`);
    } catch {
      setError('Could not create the list -- please try again.');
      setSaving(false);
    }
  }

  return (
    <>
      <Box title="Build a list">
        {items.length === 0 ? (
          <p>
            Your list is empty. Browse <Link to="/torrents">Torrents</Link> and use &ldquo;Add to list&rdquo; on a
            release to start one.
          </p>
        ) : (
          <>
            <p className="center">
              <input
                type="text"
                placeholder="List title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                size={40}
              />
            </p>
            <p className="center">
              <input
                type="text"
                placeholder="Description (optional)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                size={40}
              />
            </p>
            <p className="center">
              <select value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </p>
            {error && <p className="center">{error}</p>}
            <p className="center">
              <button type="button" onClick={share} disabled={saving || !title.trim()}>
                {saving ? 'Creating…' : 'Get share link'}
              </button>
            </p>
          </>
        )}
      </Box>

      {items.length > 0 && (
        <Box title={`${items.length} release${items.length === 1 ? '' : 's'}`}>
          <table className="torrent_table">
            <tbody>
              {items.map((item) => (
                <tr className="group" key={item.id}>
                  <td>
                    {item.artists.length > 0 && (
                      <>
                        {item.artists.map((a, i) => (
                          <span key={a.id}>
                            {i > 0 && ', '}
                            {a.name}
                          </span>
                        ))}
                        {' – '}
                      </>
                    )}
                    <Link to={`/torrents/${item.id}`}>{item.name}</Link>
                  </td>
                  <td>{item.year ?? '—'}</td>
                  <td>
                    <button type="button" onClick={() => remove(item.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
      )}
    </>
  );
}
