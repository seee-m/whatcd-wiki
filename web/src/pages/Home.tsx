import { Link } from 'react-router-dom';
import { Box } from '../components/Box';
import wcdLogo from '../assets/wcd-logo.png';
import newGif from '../assets/new.gif';

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
    title: "Remembering What.CD, the Internet's Greatest Music Archive",
    url: 'https://www.vice.com/en/article/remembering-whatcd-the-internets-greatest-music-archive/',
  },
  {
    title: 'Torrent Service What.cd Has Shut Down After Raid',
    url: 'https://www.vulture.com/2016/11/torrent-service-whatcd-has-shut-down-after-raid.html',
  },
];

export function Home() {
  return (
    <div className="main_column" style={{ margin: '20px auto', float: 'none' }}>
      <Box title="what.cd wiki">
        <p>
          The what.cd wiki is a read-only, semi-faithful recreation of what.cd's browsing experience, built from the
          site's final database export. There is no login, no forum, and <strong>nothing here can be downloaded</strong> &mdash; but
          you can browse the releases, artists, collages, and wiki as they looked before the site closed in late
          2016. I&rsquo;ve also added a few quality-of-life tweaks, (random button, Discogs integration, and a few
          new sort options), so that you can get the most out of this amazing repository of information.
        </p>
        <p>
          The death of what.cd (and oink before it) heralded the &lsquo;end of an era&rsquo; of music piracy,
          (perhaps due to the prevalence of streaming and new forms of distribution as much as anything else), and
          though there are still plenty of places you can go to download music for free, nothing else has ever come
          close to replicating such a large, vibrant and dedicated community.
        </p>
        <p>So long, and thanks for all the fish.</p>
      </Box>

      <Box title="Browse">
        <ul className="plain-list">
          <li>
            <Link to="/torrents">Browse Torrents</Link> &mdash; 1M+ music releases, and a variety of other media
          </li>
          <li>
            <Link to="/artists">Search Artists</Link> &mdash; 885,304 named artists with similarity ranking
          </li>
          <li>
            <Link to="/collages">Browse Collages</Link> &mdash; 26,761 user-created collages for discovering new
            music
          </li>
          <li>
            <Link to="/tags">Browse Tags</Link> &mdash; 142,119 unique tags linked to releases
          </li>
          <li>
            <Link to="/wiki">Wiki</Link> &mdash; 274 text-only preserved help articles
          </li>
          <li>
            <Link to="/list">Lists</Link> &mdash; Create shareable lists from the what.cd archive
          </li>
          <li>
            <Link to="/tv">what.tv</Link> &mdash; Surf over 300k releases ready to play instantly{' '}
            <img src={newGif} alt="New" className="new-badge" />
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

      <Box title="About">
        <p>
          Project built and maintained by{' '}
          <a href="https://www.c-m.work" target="_blank" rel="noopener noreferrer">
            www.c-m.work
          </a>{' '}
          &mdash; send emails to <a href="mailto:what@c-m.work">what@c-m.work</a>
        </p>
        <img src={wcdLogo} alt="WCD - Music on the Internet" width={128} />
      </Box>
    </div>
  );
}
