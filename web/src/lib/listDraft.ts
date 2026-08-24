import type { ArtistRef } from './api';

// The in-progress list a visitor is assembling, kept entirely client-side
// until they explicitly share it -- nothing hits the server just from
// browsing and adding releases. Denormalized item fields (name/year/
// artists) are captured at add-time from data already on hand on the
// release detail page, so the builder page never needs an extra fetch just
// to render the draft.
const STORAGE_KEY = 'wcdwiki.listDraft.v1';
const CHANGE_EVENT = 'wcdwiki:list-draft-changed';

export interface DraftItem {
  id: number;
  name: string;
  year: number | null;
  artists: ArtistRef[];
}

function read(): DraftItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(items: DraftItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage unavailable (private browsing, quota) -- draft just won't persist.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function getDraft(): DraftItem[] {
  return read();
}

export function isInDraft(id: number): boolean {
  return read().some((item) => item.id === id);
}

export function addToDraft(item: DraftItem) {
  const items = read();
  if (items.some((i) => i.id === item.id)) return;
  write([...items, item]);
}

export function removeFromDraft(id: number) {
  write(read().filter((item) => item.id !== id));
}

export function clearDraft() {
  write([]);
}

export function onDraftChange(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener('storage', callback);
  };
}
