import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import Flipbook from './product/Flipbook';
import FlipbookManager from './product/FlipbookManager';
import useFlipbookImage from './product/flipbookImages';
import PAGES from './product/profilePages';
import '../styles/flipbook.css';

// Product: the company profile as a page-turning flipbook.
//
// Two sources feed the same book. The built-in pages are the 2025 profile transcribed into
// HTML, which is what shows out of the box; upload the real exported artwork and those take
// over instead. Delete the uploads and the built-in profile comes back -- there is no third
// state to reason about, so nobody ends up looking at half a brochure.
//
// Every page kind renders through this one switch, so the book stays visually consistent and
// a new page type is a case here rather than another bespoke layout.

// A real component, not a branch of the switch: it needs a hook to resolve the image, and
// renderPage is called mid-render from Flipbook, where a conditional hook would land in the
// wrong hook list.
function ImagePage({ page }) {
  const url = useFlipbookImage(page.id);
  return (
    <div className="flipbook-page fb-image-page">
      {url
        ? <img src={url} alt={page.caption || `Page ${page.number || 1}`} className="fb-image" draggable="false" />
        : <div className="fb-image-loading"><span /></div>}
      {page.caption && <span className="fb-image-caption">{page.caption}</span>}
      {page.number && <span className="fb-page-num">{page.number}</span>}
    </div>
  );
}

function ProfilePage(page) {
  if (!page) return <div className="flipbook-page flipbook-blank" />;

  const accent = page.accent;
  const chrome = (
    <>
      {page.number && <span className="fb-page-num">{page.number}</span>}
      {page.section && <span className="fb-page-tab">{page.section}</span>}
    </>
  );

  switch (page.kind) {
    case 'image':
      return <ImagePage page={page} />;

    case 'cover':
      return (
        <div className="flipbook-page fb-cover">
          <div className="fb-cover-blob fb-cover-blob-navy" />
          <div className="fb-cover-blob fb-cover-blob-orange" />
          <div className="fb-cover-mark">
            <span className="fb-logo-g">G</span>
            <span className="fb-logo-word">GRAPHIC<em>STAR</em></span>
            <span className="fb-logo-tag">{page.tagline}</span>
          </div>
          <div className="fb-cover-title">
            <div className="fb-cover-eyebrow">{page.eyebrow}</div>
            <div className="fb-cover-main">{page.title}</div>
            <div className="fb-cover-rule" />
            <div className="fb-cover-sub">{page.subtitle}</div>
          </div>
        </div>
      );

    case 'text':
      return (
        <div className="flipbook-page fb-text">
          {chrome}
          <h2 className="fb-heading">{page.heading}</h2>
          <p className="fb-body">{page.body}</p>
          <div className="fb-text-glow" />
        </div>
      );

    case 'divider':
      return (
        <div className="flipbook-page fb-divider">
          {chrome}
          <div className="fb-divider-inner">
            <div className="fb-divider-eyebrow">{page.eyebrow}</div>
            <div className="fb-divider-title">{page.title}</div>
          </div>
        </div>
      );

    case 'grid':
      return (
        <div className="flipbook-page fb-grid-page" style={accent ? { '--fb-accent': accent } : undefined}>
          {chrome}
          <h2 className="fb-grid-heading">{page.heading}</h2>
          <div className="fb-tiles">
            {page.items.map((item, i) => (
              // Staggered so the tiles arrive in sequence as the page lands rather than all
              // snapping in at once.
              <div className="fb-tile" key={item} style={{ animationDelay: `${i * 45}ms` }}>
                <span className="fb-tile-mark" aria-hidden="true">◧</span>
                <span className="fb-tile-label">{item}</span>
              </div>
            ))}
          </div>
        </div>
      );

    case 'work':
      return (
        <div className="flipbook-page fb-work">
          {chrome}
          <h2 className="fb-work-heading">{page.heading}</h2>
          <div className="fb-work-client">{page.client}</div>
          <div className="fb-work-frame">
            <span className="fb-work-mark">GRAPHIC<em>STAR</em></span>
          </div>
        </div>
      );

    case 'clients':
      return (
        <div className="flipbook-page fb-clients">
          {chrome}
          <h2 className="fb-heading fb-center">{page.heading}</h2>
          <div className="fb-client-grid">
            {page.clients.map((c, i) => (
              <span className="fb-client" key={c} style={{ animationDelay: `${i * 25}ms` }}>{c}</span>
            ))}
          </div>
          <h3 className="fb-subheading">Licenses / Certifications</h3>
          <ul className="fb-cert-list">
            {page.certifications.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </div>
      );

    case 'professionals':
      return (
        <div className="flipbook-page fb-pros">
          {chrome}
          <h2 className="fb-heading fb-center">{page.heading}</h2>
          {page.people.map((p) => (
            <div className="fb-pro" key={p.name}>
              <div className="fb-pro-head">
                <div className="fb-pro-name">{p.name}</div>
                <div className="fb-pro-role">{p.role}</div>
              </div>
              <ul className="fb-pro-licenses">
                {p.licenses.map((l) => <li key={l}>{l}</li>)}
              </ul>
            </div>
          ))}
        </div>
      );

    case 'back':
      return (
        <div className="flipbook-page fb-back">
          <div className="fb-cover-mark centered">
            <span className="fb-logo-g">G</span>
            <span className="fb-logo-word">GRAPHIC<em>STAR</em></span>
            <span className="fb-logo-tag">{page.tagline}</span>
          </div>
        </div>
      );

    default:
      return <div className="flipbook-page flipbook-blank" />;
  }
}

export default function Product() {
  const [uploaded, setUploaded] = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/product-flipbook');
      setUploaded(data.pages || []);
      setCanManage(!!data.can_manage);
    } catch {
      // The module still has a profile to show without the API, so a failure here is quiet.
      setUploaded([]);
    } finally { setLoaded(true); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const pages = useMemo(() => {
    if (!uploaded.length) return PAGES;
    // A leaf is a sheet with two sides, so an odd number of uploads would pair the last page
    // with nothing. The blank keeps the final page on a sheet of its own rather than turning
    // into the back of the one before it.
    const built = uploaded.map((p, i) => ({
      kind: 'image', id: p.id, caption: p.caption, number: i === 0 ? null : i,
    }));
    if (built.length % 2) built.push({ kind: 'blank' });
    return built;
  }, [uploaded]);

  return (
    <div>
      <div className="page-header">
        <h1>Product</h1>
        <span className="muted">
          {uploaded.length ? 'Company Profile' : 'Company Profile 2025'} — click a page edge or use ← → to turn
        </span>
      </div>
      {loaded && canManage && <FlipbookManager pages={uploaded} onChange={load} />}
      {/* Remounted when the source changes so the reader is not left on leaf 9 of a book that
          just became four pages long. */}
      <Flipbook
        key={uploaded.length ? `uploaded-${uploaded.length}` : 'built-in'}
        pages={pages}
        renderPage={ProfilePage}
      />
    </div>
  );
}
