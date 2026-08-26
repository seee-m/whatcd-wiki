import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type ReleaseDetail, type ReleaseExtras } from '../lib/api';
import { Box } from '../components/Box';
import { addToDraft, removeFromDraft, isInDraft } from '../lib/listDraft';
import { RELEASE_TYPES } from '../lib/releaseTypes';
import { loadYouTubeIframeApi, youtubeVideoId, type YouTubePlayer } from '../lib/youtube';
import warningGif from '../assets/tv-warning.gif';

interface PoolState {
  healthy: boolean;
  threshold: number;
}

export function TvPlay() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  const [release, setRelease] = useState<ReleaseDetail | null>(null);
  const [extras, setExtras] = useState<ReleaseExtras | null>(null);
  const [song, setSong] = useState<{ url: string; title: string } | null>(null);
  const [inDraft, setInDraft] = useState(false);
  const [nextLoading, setNextLoading] = useState(false);
  const [nextError, setNextError] = useState<string | null>(null);
  // TvSetup.tsx's "Start" already knows whether this filter combo's pool
  // was healthy (it just made the same /api/tv/random call) and hands
  // that off via router state -- ephemeral per-roll info, not a filter,
  // so it doesn't belong in the URL alongside tags/years/types. Absent on
  // a direct link or a hard refresh (router state doesn't survive those),
  // in which case null just means "don't know" -- no warning shown rather
  // than guessing.
  const initialPool = (location.state as { poolHealthy?: boolean; poolThreshold?: number } | null) ?? null;
  const [pool, setPool] = useState<PoolState | null>(
    initialPool && typeof initialPool.poolHealthy === 'boolean' && typeof initialPool.poolThreshold === 'number'
      ? { healthy: initialPool.poolHealthy, threshold: initialPool.poolThreshold }
      : null,
  );

  const playerRef = useRef<YouTubePlayer | null>(null);
  const playerElRef = useRef<HTMLDivElement | null>(null);
  const playerReadyRef = useRef(false);
  const pendingVideoIdRef = useRef<string | null>(null);

  const tagNames = useMemo(() => (params.get('tagNames') ?? '').split(',').filter(Boolean), [params]);
  const yearFrom = params.get('yearFrom') ?? '';
  const yearTo = params.get('yearTo') ?? '';
  const typeNames = useMemo(() => {
    const ids = new Set((params.get('type') ?? '').split(',').filter(Boolean));
    return RELEASE_TYPES.filter((t) => ids.has(String(t.id))).map((t) => t.name);
  }, [params]);

  // Rebuilds the same tags/type/year filters the current pick was drawn
  // from, so "Next" (and the auto-advance-on-end below) stays a shuffle
  // within the chosen station rather than resetting to "anything".
  function filterParams(): URLSearchParams {
    const p = new URLSearchParams();
    const tags = params.get('tags');
    const type = params.get('type');
    if (tags) p.set('tags', tags);
    if (type) p.set('type', type);
    if (yearFrom) p.set('yearFrom', yearFrom);
    if (yearTo) p.set('yearTo', yearTo);
    return p;
  }

  async function goNext() {
    if (!release) return;
    setNextLoading(true);
    setNextError(null);
    try {
      const fp = filterParams();
      fp.set('exclude', String(release.id));
      const { id: newId, poolHealthy, poolThreshold } = await api.tvRandom(fp);
      setPool({ healthy: poolHealthy, threshold: poolThreshold });
      navigate(`/tv/${newId}?${params.toString()}`, { replace: true });
    } catch (err) {
      setNextError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setNextLoading(false);
    }
  }

  // The onStateChange/onError handlers below are registered once, when the
  // player is first created -- they need the *current* goNext/song/release
  // (closing over filters and the currently-loaded video) rather than
  // whatever was current at creation time, so these are kept in refs that
  // every render refreshes.
  const goNextRef = useRef(goNext);
  const songRef = useRef(song);
  const releaseIdRef = useRef<number | null>(null);
  useEffect(() => {
    goNextRef.current = goNext;
    songRef.current = song;
    releaseIdRef.current = release?.id ?? null;
  });

  // No cover-art fetch here (unlike the regular release page) -- what.tv
  // already shows the video itself (which carries its own thumbnail/cover
  // via the YouTube player), so a separate cover-art lookup would just be
  // an extra API call (and, for an uncached release, an extra iTunes/
  // Discogs/MusicBrainz round trip) for something already on screen.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setNextError(null);
    // summary: this page shows the title, artists, label, catalogue
    // number and tags -- never the editions table or the collage list. It
    // also re-fetches on every "Next" and auto-advances forever once a
    // video ends, so asking for the parts it renders is worth doing.
    api.torrent(id, true).then((r) => {
      if (cancelled) return;
      setRelease(r);
      setInDraft(isInDraft(r.id));
    });
    api
      .torrentExtras(id)
      .then((r) => {
        if (cancelled) return;
        setExtras(r);
      })
      .catch(() => {});
    // Deliberately does NOT null out release/extras/song before the new
    // ones arrive. That used to seem harmless (just a loading flicker),
    // but it broke the player on every single "Next": this whole
    // component returns a bare <p>Loading…</p> while `release` is null,
    // which unmounts the entire tree -- including the <div> the YouTube
    // iframe lives inside. React tears that div out of the DOM, but the
    // YT.Player JS object survives in playerRef with no live iframe left
    // to control, so the next loadVideoById() call has nothing to update.
    // Confirmed live: title/artist/tags update correctly on "Next", but
    // the player area goes completely blank -- exactly this. Leaving the
    // old release on screen until the new one is ready keeps that div
    // permanently mounted, so the same player instance can actually be
    // reused across every "Next" the way the effect below assumes.
    //
    // Cancellation guard still matters here independent of that: without
    // it, a stale response for an old id resolving after a newer one
    // would silently overwrite correct state with mismatched data.
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Picks one song at random out of the release's videos, once per
  // release -- what.tv plays a single track per station hop, not the
  // release's full video list. Only ever picks from actually-embeddable
  // YouTube videos: the server already filters new lookups down to those
  // (see api/src/routes/tv.ts), but release_extras is shared with the
  // regular release page's cache, so an older row populated before that
  // filter existed can still hold a non-YouTube (e.g. Vimeo) video --
  // if that leaves nothing playable, skip straight to another release
  // instead of showing a dead player.
  useEffect(() => {
    if (!extras) return;
    const playable = extras.videos.filter((v) => youtubeVideoId(v.url));
    if (playable.length > 0) {
      setSong(playable[Math.floor(Math.random() * playable.length)]);
    } else {
      goNextRef.current();
    }
  }, [extras]);

  // Creates the YouTube player once a song is chosen, then reuses it (via
  // loadVideoById) for every later song -- loadVideoById auto-plays on its
  // own, which is what makes the "advance to the next song" case above
  // autoplay without needing to touch playerVars again.
  //
  // The player isn't usable the instant `new YT.Player(...)` returns --
  // API calls made before its onReady event fires log a "not attached to
  // the DOM" warning and are dropped (hit this for real: clicking "Next"
  // quickly after the initial load called loadVideoById on a still-
  // initializing player and silently broke it). playerReadyRef/
  // pendingVideoIdRef defer any such call until onReady actually fires.
  //
  // Also depends on `release`, not just `song`: the whole page renders as
  // just "Loading…" (no `<div ref={playerElRef}>` in the DOM at all) until
  // `release` arrives, but `torrentExtras` is a single indexed cache
  // lookup while `torrent` joins editions/artists/tags/collages -- extras
  // (and so `song`) frequently resolves first. Without `release` here,
  // that ordering left `playerElRef.current` null with nothing to retry
  // once the div finally mounted, so the player silently never appeared
  // even though the release genuinely had a YouTube video.
  useEffect(() => {
    const videoId = song ? youtubeVideoId(song.url) : null;
    if (!videoId || !release) return;
    let cancelled = false;
    loadYouTubeIframeApi().then((YT) => {
      if (cancelled) return;
      if (playerRef.current) {
        if (playerReadyRef.current) {
          playerRef.current.loadVideoById(videoId);
        } else {
          pendingVideoIdRef.current = videoId;
        }
      } else if (playerElRef.current) {
        playerRef.current = new YT.Player(playerElRef.current, {
          videoId,
          playerVars: { autoplay: 1, rel: 0 },
          events: {
            onReady: () => {
              playerReadyRef.current = true;
              if (pendingVideoIdRef.current) {
                playerRef.current!.loadVideoById(pendingVideoIdRef.current);
                pendingVideoIdRef.current = null;
              }
            },
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.ENDED) goNextRef.current();
            },
            // YouTube error codes: 100 = video not found (removed or made
            // private), 101/150 = owner has disabled embedding -- both are
            // permanent, "this video does not exist for us" conditions, so
            // only those get reported to prune the cache (see
            // api/src/routes/tv.ts's /video-dead). 2 (malformed request)
            // and 5 (HTML5 player error) aren't about the video's
            // existence -- could be a transient/local glitch -- so this
            // viewer still skips ahead, but the cache isn't touched on
            // their behalf.
            onError: (e) => {
              const deadSong = songRef.current;
              const releaseId = releaseIdRef.current;
              const isPermanentlyUnplayable = e.data === 100 || e.data === 101 || e.data === 150;
              if (isPermanentlyUnplayable && deadSong && releaseId !== null) {
                api.tvReportDeadVideo(releaseId, deadSong.url).catch(() => {});
              }
              goNextRef.current();
            },
          },
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [song, release]);

  useEffect(() => {
    return () => {
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, []);

  if (!release) return <p className="center">Loading&hellip;</p>;

  const artistNames = release.artists.map((a) => a.name).join(', ');

  return (
    <>
      <h2>
        Now Playing &mdash; {song?.title ?? 'Loading…'}
        {artistNames && <> by {artistNames}</>} from <Link to={`/torrents/${release.id}`}>{release.name}</Link>
      </h2>

      <div className="detail-columns">
        <div className="sidebar">
          <Box title="Radio">
            <table className="noborder kv-table tv-radio-table">
              <tbody>
                <tr>
                  <td className="label">Tags:</td>
                  <td>{tagNames.length > 0 ? tagNames.join(', ') : 'Any'}</td>
                </tr>
                <tr>
                  <td className="label">Years:</td>
                  <td>{yearFrom || yearTo ? `${yearFrom || 'Any'} – ${yearTo || 'Any'}` : 'Any'}</td>
                </tr>
                <tr>
                  <td className="label">Types:</td>
                  <td>{typeNames.length > 0 ? typeNames.join(', ') : 'Any'}</td>
                </tr>
              </tbody>
            </table>
            {nextError && <p className="external-disclaimer">{nextError}</p>}
            <p className="action-row tv-radio-actions">
              <button type="button" className="dice-button auto-width-button" onClick={goNext} disabled={nextLoading}>
                {nextLoading ? 'Finding next…' : 'Next'}
              </button>
              <button
                type="button"
                className="dice-button auto-width-button"
                onClick={() => {
                  if (inDraft) {
                    removeFromDraft(release.id);
                  } else {
                    addToDraft({ id: release.id, name: release.name, year: release.year, artists: release.artists });
                  }
                  setInDraft(!inDraft);
                }}
              >
                {inDraft ? 'Remove from list' : 'Add to list'}
              </button>
            </p>
          </Box>

          {pool && !pool.healthy && (
            <Box title="Warning" collapsible={false}>
              <p>
                <img src={warningGif} alt="" width={28} height={28} className="tv-warning-icon" />
                Warning, your search has returned fewer than {pool.threshold} results, so this station will
                repeat itself quickly. Adjust your search parameters or browse <Link to="/tags">tags</Link> to see more.
              </p>
            </Box>
          )}
        </div>

        <div className="main_column">
          <Box
            title={
              <>
                Discogs
                {extras?.discogsUrl && (
                  <>
                    {' '}
                    <a href={extras.discogsUrl} target="_blank" rel="noopener noreferrer">
                      - View Release
                    </a>
                  </>
                )}
              </>
            }
          >
            <div className="video-embed">
              <div ref={playerElRef} />
            </div>
          </Box>

          <Box title="Release info">
            <table className="noborder kv-table">
              <tbody>
                {release.artists.length > 0 && (
                  <tr>
                    <td className="label">Artist:</td>
                    <td>
                      {release.artists.map((a, i) => (
                        <span key={a.id}>
                          {i > 0 && ', '}
                          <Link to={`/artists/${a.id}`}>{a.name}</Link>
                        </span>
                      ))}
                    </td>
                  </tr>
                )}
                {release.recordLabel && (
                  <tr>
                    <td className="label">Record Label:</td>
                    <td>{release.recordLabel}</td>
                  </tr>
                )}
                {release.catalogueNumber && (
                  <tr>
                    <td className="label">Catalogue #:</td>
                    <td>{release.catalogueNumber}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {release.tags.length > 0 && (
              <div className="tags">
                {release.tags.map((t) => (
                  <Link key={t.id} to={`/torrents?tag=${t.id}`}>
                    {t.name}
                  </Link>
                ))}
              </div>
            )}
          </Box>

          <p className="external-disclaimer">
            Video via Discogs. Not part of the original archive, may be inaccurate. This is an experimental feature.
          </p>
        </div>
      </div>
    </>
  );
}
