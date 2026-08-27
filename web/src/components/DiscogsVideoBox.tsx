import { Box } from './Box';
import { youtubeEmbedUrl } from '../lib/youtube';

export interface VideoSwitcherItem {
  key: string;
  label: string;
  title: string;
  url: string;
}

// Shared by the release page (one release's own videos) and the shared-list
// page (videos aggregated across every release in the list) -- same
// one-iframe-at-a-time switcher, just fed a differently-labeled item list.
function RefreshLink({ onRefresh, refreshing }: { onRefresh: () => void; refreshing: boolean }) {
  return (
    <a
      href="#"
      title="Re-check Discogs for a video added after this was last looked up"
      aria-label="Refresh"
      onClick={(e) => {
        e.preventDefault();
        if (!refreshing) onRefresh();
      }}
    >
      {' '}
      {refreshing ? '…' : '↺'}
    </a>
  );
}

export function DiscogsVideoBox({
  videos,
  activeVideo,
  videoClicked,
  onSelect,
  viewReleaseUrl,
  onRefresh,
  refreshing,
}: {
  videos: VideoSwitcherItem[];
  activeVideo: number;
  videoClicked: boolean;
  onSelect: (i: number) => void;
  viewReleaseUrl?: string | null;
  // Omitted on the shared-list box, which aggregates videos across many
  // releases rather than showing one release's own extras -- there's no
  // single row to refresh there.
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  // No videos to switch between -- there's nothing box-shaped to show, just
  // the Discogs link itself. Reuses the box head's own markup/styling
  // (no .body) so it still reads as a box heading, not a random link.
  //
  // Still rendered with no viewReleaseUrl as long as onRefresh exists: a
  // release with no verified Discogs match is exactly the one where a
  // manual recheck matters most (Discogs added something since the last
  // look, or the last look predates the match-verification fix) -- hiding
  // the box entirely would take away the only way to trigger one.
  if (videos.length === 0) {
    if (!viewReleaseUrl && !onRefresh) return null;
    return (
      <div className="box">
        <div className="head">
          <span className="box-title">
            Discogs
            {viewReleaseUrl && (
              <>
                {' '}
                <a href={viewReleaseUrl} target="_blank" rel="noopener noreferrer">
                  - View Release
                </a>
              </>
            )}
            {!viewReleaseUrl && ' - No match found'}
            {onRefresh && <RefreshLink onRefresh={onRefresh} refreshing={!!refreshing} />}
          </span>
        </div>
      </div>
    );
  }

  const current = videos[activeVideo];
  const embedUrl = current && youtubeEmbedUrl(current.url, videoClicked);

  return (
    <Box
      title={
        <>
          Youtube
          {viewReleaseUrl && (
            <>
              {' '}
              <a href={viewReleaseUrl} target="_blank" rel="noopener noreferrer">
                - View Release
              </a>
              {onRefresh && <RefreshLink onRefresh={onRefresh} refreshing={!!refreshing} />}
            </>
          )}
        </>
      }
    >
      {embedUrl && (
        <div className="video-embed">
          <iframe
            src={embedUrl}
            title={current.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      )}
      <ul className="video-switcher">
        {videos.map((v, i) => (
          <li key={v.key} className={i === activeVideo ? 'active' : undefined}>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onSelect(i);
              }}
            >
              {v.label}
            </a>
          </li>
        ))}
      </ul>
    </Box>
  );
}
