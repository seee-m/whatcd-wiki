import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import logo from '../assets/logo.png';
import { api } from '../lib/api';

// Mirrors Gazelle's real #menu structure: one <li id="nav_x"> per section,
// highlighted via body#x #nav_x (see shiro.css). Home/Torrents/Collages/Wiki
// are real routes; everything else has no backing data in this archive, so
// it renders identically but inert -- present for "looks the same", not
// wired to anything (see the plan's "Nav / chrome fidelity" section).
const MENU: { id: string; label: string; path?: string }[] = [
  { id: 'index', label: 'Home', path: '/' },
  { id: 'torrents', label: 'Torrents', path: '/torrents' },
  { id: 'collages', label: 'Collages', path: '/collages' },
  { id: 'requests', label: 'Requests' },
  { id: 'forums', label: 'Forums' },
  { id: 'irc', label: 'IRC' },
  { id: 'top10', label: 'Top 10' },
  { id: 'rules', label: 'Rules' },
  { id: 'wiki', label: 'Wiki', path: '/wiki' },
  { id: 'staff', label: 'Staff' },
];

const MEMBER_LINKS = [
  'Inbox',
  'Staff Inbox',
  'Uploads',
  'Bookmarks',
  'Notifications',
  'Subscriptions',
  'Comments',
  'Friends',
  'Better',
];

function activeSectionId(pathname: string): string {
  if (pathname.startsWith('/torrents')) return 'torrents';
  if (pathname.startsWith('/collages')) return 'collages';
  if (pathname.startsWith('/wiki')) return 'wiki';
  if (pathname === '/') return 'index';
  return '';
}

function TorrentsSearch() {
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    navigate(`/torrents?q=${encodeURIComponent(q)}`);
  };
  return (
    <form onSubmit={onSubmit}>
      <input type="text" placeholder="Torrents" size={17} value={q} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}

function RandomTorrentButton() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const onClick = async () => {
    setLoading(true);
    try {
      const { id } = await api.randomTorrent();
      navigate(`/torrents/${id}`);
    } finally {
      setLoading(false);
    }
  };
  return (
    <button type="button" className="dice-button" title="Random release" aria-label="Random release" onClick={onClick} disabled={loading}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
        <path d="M16 8h.01" />
        <path d="M16 12h.01" />
        <path d="M16 16h.01" />
        <path d="M8 8h.01" />
        <path d="M8 12h.01" />
        <path d="M8 16h.01" />
      </svg>
    </button>
  );
}

function ArtistsSearch() {
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    navigate(`/artists?q=${encodeURIComponent(q)}`);
  };
  return (
    <form onSubmit={onSubmit}>
      <input type="text" placeholder="Artists" size={17} value={q} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}

export function Nav() {
  const location = useLocation();
  const active = activeSectionId(location.pathname);

  return (
    <div id="header">
      <div id="userinfo">
        <ul id="userinfo_major">
          {MEMBER_LINKS.map((label) => (
            <li key={label}>
              <span className="inert">{label}</span>
            </li>
          ))}
          <li>
            <span className="inert">Upload</span>
          </li>
          <li>
            <span className="inert">Invite (0)</span>
          </li>
          <li>
            <span className="inert">Donate</span>
          </li>
        </ul>
      </div>

      <div id="logo">
        <Link to="/">
          <img src={logo} alt="what.cd" width={240} height={70} />
        </Link>
      </div>

      <div id="menu">
        <ul>
          {MENU.map((item) => (
            <li key={item.id} id={active === item.id ? `nav_${item.id}` : undefined}>
              {item.path ? (
                <Link to={item.path}>{item.label}</Link>
              ) : (
                <span className="inert">{item.label}</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div id="searchbars">
        <div className="searchbars-inner">
          <ul>
            <li className="torrents-search-group">
              <RandomTorrentButton />
              <TorrentsSearch />
            </li>
            <li>
              <ArtistsSearch />
            </li>
            <li>
              <form onSubmit={(e) => e.preventDefault()}>
                <input type="text" placeholder="Forums" size={17} disabled className="inert-input" />
              </form>
            </li>
            <li>
              <form onSubmit={(e) => e.preventDefault()}>
                <input type="text" placeholder="Users" size={20} disabled className="inert-input" />
              </form>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
