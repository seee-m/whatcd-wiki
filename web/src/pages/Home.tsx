import { Link } from 'react-router-dom';
import { Box } from '../components/Box';

const FURTHER_READING = [
  {
    title: 'The Lost Joy of Music Piracy',
    url: 'https://www.pigeonsandplanes.com/read/music-piracy-what-cd-oink-nine-inch-nails-streaming',
  },
  {
    title: 'What.cd is gone: A eulogy for the greatest music collection in the world',
    url: 'https://qz.com/840661/what-cd-is-gone-a-eulogy-for-the-greatest-music-collection-in-the-world',
  },
  {
    title: 'What.CD is shutting down',
    url: 'https://news.ycombinator.com/item?id=12982408',
  },
  {
    title: 'The Death of What.cd and the End of Music Torrenting',
    url: 'https://nymag.com/intelligencer/2016/11/the-death-of-what-cd-and-the-end-of-music-torrenting.html',
  },
  {
    title: 'Torrent Service What.cd Has Shut Down After Raid',
    url: 'https://www.vulture.com/2016/11/torrent-service-whatcd-has-shut-down-after-raid.html',
  },
];

export function Home() {
  return (
    <div className="main_column" style={{ margin: '20px auto', float: 'none' }}>
      <Box title="what.cd (read-only archive)">
        <p>
          The what.cd wiki is a read-only, semi-faithful recreation of what.cd's browsing experience, built from the
          site's final database export. There is no login, no forum, and nothing here can be downloaded &mdash; it
          exists to browse the release, artist, collage, and wiki metadata as it looked before the site closed in
          late 2016.
        </p>
        <p>
          The death of what.cd really did herald the &lsquo;end of an era&rsquo; of music piracy, (perhaps due to
          the prevalence of streaming and new forms of distribution as much as anything else), and though there are
          still plenty of places you can go to download music for free: nothing else has ever come close to
          replicating such a large, vibrant and dedicated community.
        </p>
        <p>So long, and thanks for all the fish&hellip;</p>
      </Box>

      <Box title="Browse">
        <ul className="plain-list">
          <li>
            <Link to="/torrents">Browse Torrents</Link> &mdash; releases, filterable by category
          </li>
          <li>
            <Link to="/artists">Search Artists</Link>
          </li>
          <li>
            <Link to="/collages">Browse Collages</Link>
          </li>
          <li>
            <Link to="/tags">Browse Tags</Link>
          </li>
          <li>
            <Link to="/wiki">Wiki</Link> &mdash; 274 preserved help articles
          </li>
        </ul>
      </Box>

      <Box title="Further reading">
        <p>For more information on the history and cultural impact of what.cd you can peruse the following links:</p>
        <ul className="plain-list">
          {FURTHER_READING.map((link) => (
            <li key={link.url}>
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                {link.title}
              </a>
            </li>
          ))}
        </ul>
      </Box>
    </div>
  );
}
