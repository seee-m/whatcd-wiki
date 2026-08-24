import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Home } from './pages/Home';
import { TorrentsBrowse } from './pages/TorrentsBrowse';
import { TorrentGroup } from './pages/TorrentGroup';
import { ArtistSearch } from './pages/ArtistSearch';
import { Artist } from './pages/Artist';
import { CollagesBrowse } from './pages/CollagesBrowse';
import { Collage } from './pages/Collage';
import { Tags } from './pages/Tags';
import { Wiki } from './pages/Wiki';
import { WikiArticle } from './pages/WikiArticle';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/torrents" element={<TorrentsBrowse />} />
        <Route path="/torrents/:id" element={<TorrentGroup />} />
        <Route path="/artists" element={<ArtistSearch />} />
        <Route path="/artists/:id" element={<Artist />} />
        <Route path="/collages" element={<CollagesBrowse />} />
        <Route path="/collages/:id" element={<Collage />} />
        <Route path="/tags" element={<Tags />} />
        <Route path="/wiki" element={<Wiki />} />
        <Route path="/wiki/:id" element={<WikiArticle />} />
      </Routes>
    </Layout>
  );
}
