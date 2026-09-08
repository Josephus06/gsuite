import { Link } from 'react-router-dom';

// Knowledge Base: registered as a module and permissioned, but not built yet.
//
// It has a page and a nav entry because the Archiver was asked for as a three-part section, and a
// dropdown missing one of its items is worse than one that says plainly where that item has got
// to. This page exists to say so rather than to leave a dead link.
export default function ArchiverKnowledgeBase() {
  return (
    <div>
      <div className="page-header">
        <h1>Knowledge Base</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn btn-sm" to="/archiver/credentials">Credentials</Link>
          <Link className="btn btn-sm" to="/archiver/files">Files</Link>
        </div>
      </div>

      <div className="card">
        <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>Not built yet</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          This is the third module of the Archiver and has been registered so its permissions exist, but
          nothing has been built behind it. The other two are ready:
        </p>
        <ul className="muted" style={{ marginTop: 0 }}>
          <li><strong>Credentials</strong> — subscription and licence logins, encrypted, revealed only with an emailed code.</li>
          <li><strong>Files</strong> — contracts, permits and certificates, kept with their version history.</li>
        </ul>
        <p className="muted" style={{ marginBottom: 0 }}>
          Say what a knowledge-base article should hold — written procedures, how-to guides, troubleshooting
          notes — and it can be built alongside them.
        </p>
      </div>
    </div>
  );
}
