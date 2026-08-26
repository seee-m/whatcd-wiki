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
export function DiscogsVideoBox({
  videos,
  activeVideo,
  videoClicked,
  onSelect,
  viewReleaseUrl,
}: {
  videos: VideoSwitcherItem[];
  activeVideo: number;
  videoClicked: boolean;
  onSelect: (i: number) => void;
  viewReleaseUrl?: string | null;
}) {
  const current = videos[activeVideo];
  const embedUrl = current && youtubeEmbedUrl(current.url, videoClicked);

  return (
    <Box
      title={
        <>
          Youtube <span className="box-title-note">(Matching links via Discogs, may be inaccurate or incomplete)</span>
          {viewReleaseUrl && (
            <>
              {' '}
              <a href={viewReleaseUrl} target="_blank" rel="noopener noreferrer">
                - View Release
              </a>
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
