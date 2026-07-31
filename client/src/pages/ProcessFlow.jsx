import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import Modal from '../components/Modal';
import {
  CANVAS_W, CANVAS_H, NODE_W, NODE_H, DIAMOND, NODES, EDGES, GUIDES, LEGEND,
} from '../data/processFlow';

// Process Flow: the order-to-cash chart from the operations manual, drawn as clickable
// nodes. Clicking any box opens the how-to for that step. The chart itself is pure
// layout data (client/src/data/processFlow.js) -- nothing here talks to the API, so the
// page works even for a user whose permissions hide most of the modules it describes.

const STUB = 18;      // how far an edge leaves a node before it may turn
const CORNER = 8;     // corner radius on the elbows

function nodeBox(n) {
  const isDecision = n.kind === 'decision';
  return { ...n, w: isDecision ? DIAMOND : NODE_W, h: isDecision ? DIAMOND : NODE_H };
}

// A port is a point on a node's edge plus the direction an edge must leave in.
function port(box, side, offset = 0) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (side === 'top') return { x: cx + offset, y: box.y, dx: 0, dy: -1 };
  if (side === 'left') return { x: box.x, y: cy + offset, dx: -1, dy: 0 };
  if (side === 'right') return { x: box.x + box.w, y: cy + offset, dx: 1, dy: 0 };
  return { x: cx + offset, y: box.y + box.h, dx: 0, dy: 1 };
}

// Orthogonal (Manhattan) routing: leave each port along its own normal for STUB px, then
// join the two stub ends with axis-aligned segments. viaX/viaY force the connecting run
// onto a specific channel, which is how the long loop-backs avoid crossing the spine.
function routePoints(a, b, viaX, viaY) {
  // Between two nodes that sit closer together than 2 x STUB the stubs would overshoot
  // each other and the path would visibly double back, so shorten them to fit the gap.
  const gap = Math.hypot(b.x - a.x, b.y - a.y);
  const stub = Math.max(2, Math.min(STUB, gap / 2 - 2));
  const p1 = { x: a.x + a.dx * stub, y: a.y + a.dy * stub };
  const p2 = { x: b.x + b.dx * stub, y: b.y + b.dy * stub };
  const mid = [];
  if (viaX != null) {
    mid.push({ x: viaX, y: p1.y }, { x: viaX, y: p2.y });
  } else if (viaY != null) {
    mid.push({ x: p1.x, y: viaY }, { x: p2.x, y: viaY });
  } else {
    const aVertical = a.dx === 0;
    const bVertical = b.dx === 0;
    if (aVertical && bVertical) {
      if (Math.abs(p1.x - p2.x) > 0.5) {
        const midY = (p1.y + p2.y) / 2;
        mid.push({ x: p1.x, y: midY }, { x: p2.x, y: midY });
      }
    } else if (aVertical) {
      mid.push({ x: p1.x, y: p2.y });
    } else if (bVertical) {
      mid.push({ x: p2.x, y: p1.y });
    } else {
      const midX = (p1.x + p2.x) / 2;
      mid.push({ x: midX, y: p1.y }, { x: midX, y: p2.y });
    }
  }
  const raw = [{ x: a.x, y: a.y }, p1, ...mid, p2, { x: b.x, y: b.y }];
  return raw.filter((p, i) => i === 0 || Math.abs(p.x - raw[i - 1].x) > 0.5 || Math.abs(p.y - raw[i - 1].y) > 0.5);
}

// Turns a polyline into a path with rounded corners, clamping the radius so it never eats
// more than half of either adjoining segment.
function roundedPath(pts) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(CORNER, inLen / 2, outLen / 2);
    if (r < 1) { d += ` L ${cur.x} ${cur.y}`; continue; }
    const inUx = (cur.x - prev.x) / inLen;
    const inUy = (cur.y - prev.y) / inLen;
    const outUx = (next.x - cur.x) / outLen;
    const outUy = (next.y - cur.y) / outLen;
    d += ` L ${cur.x - inUx * r} ${cur.y - inUy * r}`;
    d += ` Q ${cur.x} ${cur.y} ${cur.x + outUx * r} ${cur.y + outUy * r}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

export default function ProcessFlow() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [openId, setOpenId] = useState(null);
  const [hoverId, setHoverId] = useState(null);
  const [zoom, setZoom] = useState(null); // null = fit to width
  const [fitScale, setFitScale] = useState(1);
  const wrapRef = useRef(null);

  const boxes = useMemo(() => {
    const map = {};
    NODES.forEach((n) => { map[n.id] = nodeBox(n); });
    return map;
  }, []);

  const edges = useMemo(() => EDGES.map((e, i) => {
    const a = port(boxes[e.from], e.fromSide || 'bottom', e.fromOffset || 0);
    const b = port(boxes[e.to], e.toSide || 'top', e.toOffset || 0);
    const pts = routePoints(a, b, e.viaX, e.viaY);
    // Park the Yes/No tag just past the first turn, where it reads as belonging to the
    // branch it labels rather than floating between two nodes.
    const anchor = pts[1] || pts[0];
    return { ...e, key: `${e.from}-${e.to}-${i}`, d: roundedPath(pts), labelX: anchor.x, labelY: anchor.y };
  }), [boxes]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => setFitScale(Math.min(1, (el.clientWidth - 4) / CANVAS_W));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setOpenId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const scale = zoom ?? fitScale;
  const guide = openId ? GUIDES[openId] : null;
  const openNode = openId ? boxes[openId] : null;
  // Everything an edge touches lights up with its node, so a loop-back is easy to trace.
  const isLit = (e) => hoverId && (e.from === hoverId || e.to === hoverId);

  return (
    <div>
      <div className="page-header">
        <h1>Process Flow</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={() => setZoom((z) => Math.max(0.3, (z ?? fitScale) - 0.15))}>−</button>
          <button className="btn btn-sm" onClick={() => setZoom(null)}>Fit</button>
          <button className="btn btn-sm" onClick={() => setZoom((z) => Math.min(2, (z ?? fitScale) + 0.15))}>+</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          The full order-to-cash process, start to finish. Click any box to open the step-by-step
          guide for that stage — where it lives, who can do it, and what to click.
        </p>
        <div className="pf-legend">
          {LEGEND.map((l) => (
            <span key={l.kind} className="pf-legend-item">
              <span className={`pf-swatch pf-${l.kind}`} />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      <div className="card pf-card">
        <div className="pf-viewport" ref={wrapRef}>
          <div
            className="pf-canvas"
            style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${scale})` }}
          >
            <svg className="pf-edges" width={CANVAS_W} height={CANVAS_H} aria-hidden="true">
              <defs>
                {/* One marker per tone: a marker's `currentColor` resolves against the
                    marker element itself, not the path referencing it, so a single shared
                    arrowhead would ignore the branch colours entirely. */}
                {['plain', 'yes', 'no', 'lit'].map((tone) => (
                  <marker key={tone} id={`pf-arrow-${tone}`} className={`pf-arrow-${tone}`}
                    viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
                    orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" />
                  </marker>
                ))}
              </defs>
              {edges.map((e) => (
                <g key={e.key} className={`pf-edge pf-edge-${e.tone || 'plain'} ${isLit(e) ? 'is-lit' : ''}`}>
                  <path d={e.d} markerEnd={`url(#pf-arrow-${isLit(e) ? 'lit' : e.tone || 'plain'})`} />
                  {e.label && (
                    <text x={e.labelX} y={e.labelY} dx={e.fromSide === 'left' ? -8 : 8} dy={-6}
                      textAnchor={e.fromSide === 'left' ? 'end' : 'start'}>
                      {e.label}
                    </text>
                  )}
                </g>
              ))}
            </svg>

            {NODES.map((n) => {
              const b = boxes[n.id];
              const decision = n.kind === 'decision';
              return (
                <button
                  key={n.id}
                  type="button"
                  className={`pf-node pf-${n.kind} ${decision ? 'is-decision' : ''} ${hoverId === n.id ? 'is-hot' : ''}`}
                  style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                  onClick={() => setOpenId(n.id)}
                  onMouseEnter={() => setHoverId(n.id)}
                  onMouseLeave={() => setHoverId(null)}
                  onFocus={() => setHoverId(n.id)}
                  onBlur={() => setHoverId(null)}
                  title={`${n.label} — open the guide`}
                >
                  {decision && <span className="pf-diamond" aria-hidden="true" />}
                  <span className="pf-node-label">{n.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {guide && (
        <Modal title={NODES.find((n) => n.id === openId).label} onClose={() => setOpenId(null)} large>
          <div className="pf-guide">
            <div className="pf-guide-meta">
              <div><span className="muted">Where</span><div>{guide.where}</div></div>
              <div><span className="muted">Who can do it</span><div>{guide.who}</div></div>
            </div>

            <p className="pf-guide-summary">{guide.summary}</p>

            <h3>Steps</h3>
            <ol className="pf-steps">
              {guide.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>

            {guide.notes?.length > 0 && (
              <>
                <h3>Worth knowing</h3>
                <ul className="pf-notes">
                  {guide.notes.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </>
            )}

            <div className="modal-actions">
              {guide.route && can(guide.route, 'can_view') && (
                <button className="btn btn-primary" onClick={() => navigate(guide.route)}>
                  Go to {openNode.kind === 'decision' ? 'the screen' : NODES.find((n) => n.id === openId).label}
                </button>
              )}
              <button className="btn" onClick={() => setOpenId(null)}>Close</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
