import Flipbook from './product/Flipbook';
import PAGES from './product/profilePages';
import '../styles/flipbook.css';

// Product: the company profile as a page-turning flipbook.
//
// Every page kind renders through this one switch, so the book stays visually consistent and a
// new page type is a case here rather than another bespoke layout.
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
                {item.image
                  ? <img src={item.image} alt="" className="fb-tile-img" />
                  : <span className="fb-tile-mark" aria-hidden="true">◧</span>}
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
  return (
    <div>
      <div className="page-header">
        <h1>Product</h1>
        <span className="muted">Company Profile 2025 — click a page edge or use ← → to turn</span>
      </div>
      <Flipbook pages={PAGES} renderPage={ProfilePage} />
    </div>
  );
}
