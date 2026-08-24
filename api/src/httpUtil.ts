// Shared by cover.ts / artistInfo.ts / discogsRelease.ts -- all lazy,
// best-effort external lookups.

export const APP_UA = 'whatcd-wiki-archive/1.0 (+local personal-use archive browser)';
const FETCH_TIMEOUT_MS = 4000;

export async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
