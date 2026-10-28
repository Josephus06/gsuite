import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import mark from '../assets/graphicstar-mark.png';
import { periodTitle } from './HrDaReport';

// DA Report > Present (2026-10-28): the saved report as a slide deck for HR's weekly briefing. HR logs
// cases day by day (each row has its Date) and presents the week: a cover, the week at a glance, the
// week day by day, each stage's cases as cards, the sections most cited, employees with more than one
// case, and a close with the report's remarks. 16:9, scaled to the screen; arrows / space / click to
// move, F for full screen.

const W = 1280;
const H = 720;
const PER_SLIDE = 6;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const utc = (v) => { const [y, m, d] = String(v).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const ymd = (d) => d.toISOString().slice(0, 10);
const shortDate = (v) => { if (!v) return ''; const d = utc(v); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
// Title case, keeping the acronyms the report uses (ISSUED NTE -> Issued NTE).
const ACRONYMS = new Set(['NTE', 'ID', 'AWOL', 'HR', 'HRD', 'IT', 'QA', 'QC', 'SM', 'CNC', 'LFP', 'DPOD']);
const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[^\p{L}])(\p{L})(\p{L}*)/gu, (m, pre, a, b) => pre + (ACRONYMS.has((a + b).toUpperCase()) ? (a + b).toUpperCase() : a.toUpperCase() + b));
// "SUSTITUIDO, LARA" -> "Lara Sustituido"
const personName = (s) => { const [last, first] = String(s || '').split(','); return titleCase(first ? `${first.trim()} ${last.trim()}` : last); };

// Severity of a sanction, lightest first -- its chip colour.
const SEVERITY = [
  [/TERMINAT/, 'sev-6'], [/SUSPEN/, 'sev-5'], [/FINAL/, 'sev-4'], [/WRITTEN/, 'sev-3'],
  [/VERBAL/, 'sev-2'], [/NTE|NOTICE/, 'sev-1'], [/NO SANCTION/, 'sev-0'],
];
const sevClass = (s) => (SEVERITY.find(([re]) => re.test(String(s || '').toUpperCase())) || [null, 'sev-0'])[1];

function countBy(list, key) {
  const m = new Map();
  for (const x of list) { const k = key(x); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]);
}

function buildSlides(rep) {
  const rows = rep.sections.flatMap((s) => s.rows.map((r) => ({ ...r, stage: s.stage })));
  const weekly = rep.report_type === 'weekly';
  const slides = [{ kind: 'cover' }];
  if (!rows.length) {
    slides.push({ kind: 'empty' }, { kind: 'close' });
    return { slides, rows };
  }
  slides.push({ kind: 'glance' });
  if (weekly && rows.some((r) => r.entry_date)) slides.push({ kind: 'days' });
  for (const s of rep.sections) {
    const pages = Math.ceil(s.rows.length / PER_SLIDE);
    for (let p = 0; p < pages; p += 1) {
      slides.push({ kind: 'stage', stage: s.stage, total: s.rows.length, page: p + 1, pages, rows: s.rows.slice(p * PER_SLIDE, (p + 1) * PER_SLIDE) });
    }
  }
  if (rows.some((r) => r.section_violated)) slides.push({ kind: 'sections' });
  if (countBy(rows, (r) => r.employee_name).some(([, n]) => n > 1)) slides.push({ kind: 'repeat' });
  slides.push({ kind: 'close' });
  return { slides, rows };
}

function Bars({ items, max, raw = false }) {
  const top = max || Math.max(1, ...items.map(([, n]) => n));
  return (
    <div className="dap-bars">
      {items.map(([label, n], i) => (
        <div className="dap-bar" key={label} style={{ animationDelay: `${0.15 + i * 0.08}s` }}>
          <div className="dap-bar-label">{raw ? label : titleCase(label)}</div>
          <div className="dap-bar-track"><div className="dap-bar-fill" style={{ width: `${(n / top) * 100}%` }} /></div>
          <div className="dap-bar-n">{n}</div>
        </div>
      ))}
    </div>
  );
}

function Header({ eyebrow, title, right }) {
  return (
    <div className="dap-head">
      <div>
        <div className="dap-eyebrow">{eyebrow}</div>
        <h2 className="dap-h2">{title}</h2>
      </div>
      {right && <div className="dap-head-right">{right}</div>}
    </div>
  );
}

function Slide({ s, rep, rows }) {
  const weekly = rep.report_type === 'weekly';
  const period = periodTitle(rep.report_type, rep.period_from, rep.period_to);
  const periodWord = weekly ? 'week' : 'month';

  if (s.kind === 'cover') {
    return (
      <div className="dap-slide dap-cover">
        <div className="dap-cover-ring" />
        <img src={mark} alt="" className="dap-cover-mark" />
        <div className="dap-eyebrow dap-rise" style={{ animationDelay: '.1s' }}>Human Resource Department · {weekly ? 'Weekly' : 'Monthly'} Briefing</div>
        <h1 className="dap-h1 dap-rise" style={{ animationDelay: '.25s' }}>Discipline Management<br />Report</h1>
        <div className="dap-rule dap-grow" />
        <div className="dap-cover-period dap-rise" style={{ animationDelay: '.45s' }}>{period}</div>
        <div className="dap-cover-meta dap-rise" style={{ animationDelay: '.6s' }}>
          {rep.report_no}{rep.created_by_name ? ` · Prepared by ${rep.created_by_name}` : ''}
        </div>
      </div>
    );
  }

  if (s.kind === 'empty') {
    return (
      <div className="dap-slide dap-center">
        <div className="dap-big-mark">✓</div>
        <h2 className="dap-h2">No disciplinary cases this {periodWord}</h2>
        <p className="dap-lead">Nothing was logged for {period}.</p>
      </div>
    );
  }

  if (s.kind === 'glance') {
    const people = new Set(rows.map((r) => r.employee_name)).size;
    const sanctioned = rows.filter((r) => r.final_sanction && !/NTE|NO SANCTION/.test(r.final_sanction)).length;
    const depts = new Set(rows.map((r) => r.department_name).filter(Boolean)).size;
    const tiles = [
      [rows.length, rows.length === 1 ? 'Case logged' : 'Cases logged'],
      [people, people === 1 ? 'Employee involved' : 'Employees involved'],
      [sanctioned, sanctioned === 1 ? 'Sanction issued' : 'Sanctions issued'],
      [depts, depts === 1 ? 'Department' : 'Departments'],
    ];
    return (
      <div className="dap-slide">
        <Header eyebrow={`The ${periodWord} at a glance`} title={period} />
        <div className="dap-tiles">
          {tiles.map(([n, l], i) => (
            <div className="dap-tile dap-rise" key={l} style={{ animationDelay: `${0.1 + i * 0.1}s` }}>
              <div className="dap-tile-n">{n}</div>
              <div className="dap-tile-l">{l}</div>
            </div>
          ))}
        </div>
        <div className="dap-two">
          <div className="dap-panel">
            <div className="dap-panel-t">By stage</div>
            <Bars items={countBy(rows, (r) => r.stage).slice(0, 6)} />
          </div>
          <div className="dap-panel">
            <div className="dap-panel-t">By final sanction</div>
            <Bars items={countBy(rows, (r) => r.final_sanction || 'NONE YET').slice(0, 6)} />
          </div>
        </div>
      </div>
    );
  }

  if (s.kind === 'days') {
    const start = utc(rep.period_from);
    const days = DAYS.map((name, i) => {
      const d = new Date(start); d.setUTCDate(start.getUTCDate() + i);
      const key = ymd(d);
      return { name, key, list: rows.filter((r) => r.entry_date === key) };
    });
    const busiest = Math.max(1, ...days.map((d) => d.list.length));
    return (
      <div className="dap-slide">
        <Header eyebrow="Day by day" title="How the week unfolded" />
        <div className="dap-days">
          {days.map((d, i) => (
            <div className={`dap-day dap-rise${d.list.length ? '' : ' is-quiet'}`} key={d.key} style={{ animationDelay: `${0.08 * i}s` }}>
              <div className="dap-day-name">{d.name.slice(0, 3)}</div>
              <div className="dap-day-date">{shortDate(d.key)}</div>
              <div className="dap-day-meter"><div style={{ height: `${(d.list.length / busiest) * 100}%` }} /></div>
              <div className="dap-day-n">{d.list.length}</div>
              <div className="dap-day-people">
                {d.list.slice(0, 4).map((r) => <div key={r.id} title={r.violation}>{personName(r.employee_name)}</div>)}
                {d.list.length > 4 && <div className="dap-more">+{d.list.length - 4} more</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (s.kind === 'stage') {
    return (
      <div className="dap-slide">
        <Header
          eyebrow={`${s.total} ${s.total === 1 ? 'case' : 'cases'}${s.pages > 1 ? ` · ${s.page} of ${s.pages}` : ''}`}
          title={titleCase(s.stage)}
        />
        <div className={`dap-cards n-${s.rows.length}`}>
          {s.rows.map((r, i) => (
            <div className="dap-card dap-rise" key={r.id || i} style={{ animationDelay: `${0.08 + i * 0.07}s` }}>
              <div className="dap-card-top">
                <div className="dap-avatar">{personName(r.employee_name).split(' ').map((w) => w[0]).slice(0, 2).join('')}</div>
                <div className="dap-card-who">
                  <div className="dap-card-name">{personName(r.employee_name)}</div>
                  <div className="dap-card-sub">{[r.position, r.department_name].filter(Boolean).join(' · ') || ' '}</div>
                </div>
                {r.entry_date && <div className="dap-card-date">{shortDate(r.entry_date)}</div>}
              </div>
              <div className="dap-card-violation">{r.violation}</div>
              {r.section_violated && <div className="dap-card-section">{r.section_violated}</div>}
              <div className="dap-card-foot">
                <span className={`dap-chip ${sevClass(r.final_sanction)}`}>{titleCase(r.final_sanction || 'Pending')}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (s.kind === 'sections') {
    return (
      <div className="dap-slide">
        <Header eyebrow="Code of conduct" title="Sections most cited" />
        <div className="dap-panel dap-panel-wide">
          <Bars raw items={countBy(rows, (r) => r.section_violated).slice(0, 7)} />
        </div>
      </div>
    );
  }

  if (s.kind === 'repeat') {
    const repeat = countBy(rows, (r) => r.employee_name).filter(([, n]) => n > 1).slice(0, 8);
    return (
      <div className="dap-slide">
        <Header eyebrow="For follow-up" title={`More than one case this ${periodWord}`} />
        <div className="dap-repeat">
          {repeat.map(([name, n], i) => {
            const theirs = rows.filter((r) => r.employee_name === name);
            return (
              <div className="dap-repeat-row dap-rise" key={name} style={{ animationDelay: `${0.08 * i}s` }}>
                <div className="dap-repeat-n">{n}</div>
                <div className="dap-repeat-who">
                  <div className="dap-card-name">{personName(name)}</div>
                  <div className="dap-card-sub">{theirs[0].department_name || ''}</div>
                </div>
                <div className="dap-repeat-what">
                  {theirs.map((r) => <span key={r.id} className={`dap-chip ${sevClass(r.final_sanction)}`}>{r.violation}</span>)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // close
  return (
    <div className="dap-slide dap-center dap-close">
      <div className="dap-cover-ring" />
      <div className="dap-eyebrow dap-rise">{period}</div>
      <h1 className="dap-h1 dap-rise" style={{ animationDelay: '.15s' }}>Thank you</h1>
      <div className="dap-rule dap-grow" />
      {rep.remarks
        ? <p className="dap-lead dap-rise" style={{ animationDelay: '.3s' }}>{rep.remarks}</p>
        : <p className="dap-lead dap-rise" style={{ animationDelay: '.3s' }}>Questions &amp; discussion</p>}
    </div>
  );
}

export default function HrDaReportPresent() {
  const { id } = useParams();
  const [rep, setRep] = useState(null);
  const [error, setError] = useState('');
  const [i, setI] = useState(0);
  const [scale, setScale] = useState(1);
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    api.get(`/hr-da-reports/${id}`).then(({ data }) => setRep(data)).catch((e) => setError(e.response?.data?.error || 'Could not load the report.'));
  }, [id]);
  useEffect(() => {
    if (rep) document.title = `${rep.report_no} · DA Report`;
  }, [rep]);

  const { slides, rows } = useMemo(() => (rep ? buildSlides(rep) : { slides: [], rows: [] }), [rep]);
  const go = useCallback((n) => setI((cur) => Math.max(0, Math.min(slides.length - 1, typeof n === 'function' ? n(cur) : n))), [slides.length]);

  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); go((c) => c + 1); }
      else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); go((c) => c - 1); }
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(slides.length - 1);
      else if (e.key === 'f' || e.key === 'F') toggleFull();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, slides.length]);

  // The controls fade after a few still seconds; any movement brings them back.
  useEffect(() => {
    let t = setTimeout(() => setIdle(true), 2500);
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 2500); };
    window.addEventListener('mousemove', wake);
    return () => { clearTimeout(t); window.removeEventListener('mousemove', wake); };
  }, []);

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  return (
    <div className={`dap-root${idle ? ' is-idle' : ''}`}>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;0,700;1,600&family=Poppins:wght@300;400;500;600&display=swap" />
      <style>{CSS}</style>
      {error && <div className="dap-msg">{error}</div>}
      {!rep && !error && <div className="dap-msg">Preparing the presentation…</div>}
      {rep && (
        <>
          <div className="dap-stage" style={{ width: W, height: H, transform: `translate(-50%, -50%) scale(${scale})` }}
            onClick={(e) => { const x = e.clientX / window.innerWidth; go((c) => c + (x < 0.3 ? -1 : 1)); }}>
            <div className="dap-frame" key={i}>
              <Slide s={slides[i]} rep={rep} rows={rows} />
            </div>
            {i > 0 && i < slides.length - 1 && (
              <div className="dap-footer">
                <span>Discipline Management Report · {periodTitle(rep.report_type, rep.period_from, rep.period_to)}</span>
                <span>{i + 1} / {slides.length}</span>
              </div>
            )}
          </div>
          <div className="dap-progress"><div style={{ width: `${((i + 1) / slides.length) * 100}%` }} /></div>
          <div className="dap-controls">
            <button onClick={() => go(i - 1)} disabled={i === 0} title="Previous (←)">‹</button>
            <div className="dap-dots">
              {slides.map((_, n) => <button key={n} className={n === i ? 'on' : ''} onClick={() => go(n)} title={`Slide ${n + 1}`} />)}
            </div>
            <button onClick={() => go(i + 1)} disabled={i === slides.length - 1} title="Next (→ or space)">›</button>
            <button className="dap-wide" onClick={toggleFull} title="Full screen (F)">⛶ Full screen</button>
            <button className="dap-wide" onClick={() => window.close()} title="Close">Close</button>
          </div>
        </>
      )}
    </div>
  );
}

const CSS = `
.dap-root { --ink:#0b1630; --ink2:#13224a; --gold:#c9a24a; --gold2:#e8cf8a; --ivory:#f6f1e7; --mist:#aab4cc;
  position:fixed; inset:0; background:radial-gradient(ellipse at 30% 20%, #1a2d5c 0%, #0b1630 55%, #060c1c 100%);
  font-family:'Poppins',system-ui,sans-serif; color:var(--ivory); overflow:hidden; user-select:none; }
.dap-msg { position:absolute; inset:0; display:grid; place-items:center; font-size:18px; color:var(--mist); }
.dap-stage { position:absolute; left:50%; top:50%; transform-origin:center; cursor:pointer;
  background:linear-gradient(160deg, #13224a 0%, #0b1630 60%, #0a1328 100%); box-shadow:0 30px 80px rgba(0,0,0,.5); overflow:hidden; }
.dap-stage::before { content:''; position:absolute; inset:18px; border:1px solid rgba(201,162,74,.22); pointer-events:none; z-index:2; }
.dap-frame { position:absolute; inset:0; animation:dapIn .55s cubic-bezier(.2,.7,.2,1) both; }
@keyframes dapIn { from { opacity:0; transform:translateX(28px); } to { opacity:1; transform:none; } }
@keyframes dapRise { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:none; } }
@keyframes dapGrow { from { transform:scaleX(0); } to { transform:scaleX(1); } }
@keyframes dapFill { from { transform:scaleX(0); } to { transform:scaleX(1); } }
.dap-rise { animation:dapRise .6s cubic-bezier(.2,.7,.2,1) both; }
.dap-grow { animation:dapGrow .8s .35s cubic-bezier(.2,.7,.2,1) both; }
.dap-slide { position:absolute; inset:0; padding:64px 80px 70px; display:flex; flex-direction:column; }
.dap-center { align-items:center; justify-content:center; text-align:center; }
.dap-eyebrow { font-size:13px; letter-spacing:.32em; text-transform:uppercase; color:var(--gold); font-weight:500; }
.dap-h1 { font-family:'Playfair Display',serif; font-weight:700; font-size:72px; line-height:1.05; margin:18px 0 0; color:#fff; }
.dap-h2 { font-family:'Playfair Display',serif; font-weight:600; font-size:42px; line-height:1.1; margin:8px 0 0; color:#fff; }
.dap-lead { font-size:20px; color:var(--mist); max-width:820px; line-height:1.6; margin-top:18px; font-weight:300; white-space:pre-line; }
.dap-rule { width:120px; height:2px; background:linear-gradient(90deg, transparent, var(--gold), transparent); margin:28px 0; transform-origin:center; }
.dap-head { display:flex; justify-content:space-between; align-items:flex-end; padding-bottom:18px; margin-bottom:30px; border-bottom:1px solid rgba(201,162,74,.25); }
.dap-head-right { color:var(--mist); font-size:14px; }

.dap-cover { justify-content:center; padding-left:110px; }
.dap-cover .dap-rule { margin-left:0; transform-origin:left; }
.dap-cover-mark { position:absolute; right:110px; top:50%; width:260px; transform:translateY(-50%); opacity:.9; filter:drop-shadow(0 10px 30px rgba(0,0,0,.4)); animation:dapRise 1s .3s both; }
.dap-cover-ring { position:absolute; right:-160px; top:50%; width:760px; height:760px; transform:translateY(-50%); border-radius:50%;
  border:1px solid rgba(201,162,74,.18); box-shadow:inset 0 0 0 60px rgba(201,162,74,.03), inset 0 0 0 140px rgba(255,255,255,.015); }
.dap-close .dap-cover-ring { right:auto; left:50%; transform:translate(-50%,-50%); }
.dap-cover-period { font-family:'Playfair Display',serif; font-style:italic; font-size:30px; color:var(--gold2); }
.dap-cover-meta { margin-top:14px; font-size:15px; color:var(--mist); letter-spacing:.04em; }
.dap-big-mark { width:110px; height:110px; border-radius:50%; display:grid; place-items:center; font-size:54px; color:var(--gold);
  border:2px solid rgba(201,162,74,.5); margin-bottom:26px; animation:dapRise .7s both; }

.dap-tiles { display:grid; grid-template-columns:repeat(4,1fr); gap:22px; margin-bottom:28px; }
.dap-tile { padding:22px 24px; border-radius:14px; background:linear-gradient(160deg, rgba(255,255,255,.07), rgba(255,255,255,.02)); border:1px solid rgba(255,255,255,.08); }
.dap-tile-n { font-family:'Playfair Display',serif; font-size:58px; line-height:1; color:var(--gold2); }
.dap-tile-l { margin-top:10px; font-size:14px; color:var(--mist); letter-spacing:.06em; text-transform:uppercase; }
.dap-two { display:grid; grid-template-columns:1fr 1fr; gap:22px; flex:1; min-height:0; }
.dap-panel { padding:22px 26px; border-radius:14px; background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.07); overflow:hidden; }
.dap-panel-wide { flex:1; padding:34px 40px; display:flex; flex-direction:column; justify-content:center; }
.dap-panel-t { font-size:12px; letter-spacing:.28em; text-transform:uppercase; color:var(--gold); margin-bottom:16px; }
.dap-bars { display:flex; flex-direction:column; gap:13px; }
.dap-panel-wide .dap-bars { gap:22px; }
.dap-bar { display:grid; grid-template-columns:minmax(150px, 42%) 1fr 36px; align-items:center; gap:14px; animation:dapRise .5s both; }
.dap-panel-wide .dap-bar { grid-template-columns:minmax(260px, 46%) 1fr 40px; font-size:17px; }
.dap-bar-label { font-size:14px; color:var(--ivory); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dap-panel-wide .dap-bar-label { font-size:16px; }
.dap-bar-track { height:10px; border-radius:6px; background:rgba(255,255,255,.07); overflow:hidden; }
.dap-bar-fill { height:100%; border-radius:6px; background:linear-gradient(90deg, #a8822f, var(--gold2)); transform-origin:left; animation:dapFill .9s .3s cubic-bezier(.2,.7,.2,1) both; }
.dap-bar-n { text-align:right; font-weight:600; color:var(--gold2); }

.dap-days { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:14px; flex:1; min-height:0; }
.dap-day { display:flex; flex-direction:column; align-items:center; padding:20px 12px; border-radius:14px; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.07); min-height:0; }
.dap-day.is-quiet { opacity:.45; }
.dap-day-name { font-size:13px; letter-spacing:.24em; text-transform:uppercase; color:var(--gold); }
.dap-day-date { font-family:'Playfair Display',serif; font-size:22px; margin-top:4px; }
.dap-day-meter { width:10px; height:110px; margin:18px 0 10px; border-radius:6px; background:rgba(255,255,255,.07); display:flex; align-items:flex-end; overflow:hidden; }
.dap-day-meter div { width:100%; border-radius:6px; background:linear-gradient(0deg, #a8822f, var(--gold2)); animation:dapRise .8s .3s both; }
.dap-day-n { font-family:'Playfair Display',serif; font-size:34px; color:var(--gold2); }
.dap-day-people { margin-top:10px; font-size:12.5px; color:var(--ivory); text-align:center; line-height:1.7; width:100%; }
.dap-day-people div { line-height:1.35; margin-bottom:6px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.dap-more { color:var(--mist); font-style:italic; }

.dap-cards { display:grid; grid-template-columns:repeat(3,1fr); grid-auto-rows:1fr; gap:20px; flex:1; min-height:0; }
.dap-cards.n-1 { grid-template-columns:minmax(0,560px); justify-content:center; grid-auto-rows:auto; align-content:center; }
.dap-cards.n-2 { grid-template-columns:repeat(2,minmax(0,480px)); justify-content:center; grid-auto-rows:auto; align-content:center; }
.dap-cards.n-4 { grid-template-columns:repeat(2,1fr); }
.dap-card { position:relative; display:flex; flex-direction:column; padding:20px 22px; border-radius:14px; min-height:0; overflow:hidden;
  background:linear-gradient(165deg, rgba(255,255,255,.08), rgba(255,255,255,.025)); border:1px solid rgba(255,255,255,.09); }
.dap-card::before { content:''; position:absolute; left:0; top:18px; bottom:18px; width:3px; border-radius:2px; background:var(--gold); }
.dap-card-top { display:flex; align-items:center; gap:12px; }
.dap-avatar { width:44px; height:44px; flex:none; border-radius:50%; display:grid; place-items:center; font-weight:600; font-size:15px;
  color:var(--ink); background:linear-gradient(140deg, var(--gold2), var(--gold)); }
.dap-card-who { min-width:0; flex:1; }
.dap-card-name { font-family:'Playfair Display',serif; font-size:19px; line-height:1.2; color:#fff; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.dap-repeat .dap-card-name { font-size:21px; }
.dap-card-sub { font-size:12.5px; color:var(--mist); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dap-card-date { font-size:12px; color:var(--gold2); border:1px solid rgba(201,162,74,.4); border-radius:20px; padding:3px 10px; flex:none; }
.dap-card-violation { flex:none; margin-top:14px; font-size:16px; line-height:1.4; max-height:2.8em; color:var(--ivory); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.dap-card-section { flex:none; margin-top:6px; font-size:12.5px; line-height:1.4; color:var(--mist); font-style:italic; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dap-cards.n-1 .dap-card-violation, .dap-cards.n-2 .dap-card-violation { -webkit-line-clamp:4; max-height:5.6em; font-size:19px; }
.dap-card-foot { margin-top:auto; padding-top:14px; }
.dap-chip { display:inline-block; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:500; letter-spacing:.03em; border:1px solid; margin:0 6px 6px 0; }
.sev-0 { color:#c9d1e4; border-color:rgba(201,209,228,.35); background:rgba(201,209,228,.08); }
.sev-1 { color:#9cc3ff; border-color:rgba(156,195,255,.4); background:rgba(156,195,255,.1); }
.sev-2 { color:#8fe0cf; border-color:rgba(143,224,207,.4); background:rgba(143,224,207,.1); }
.sev-3 { color:#f3d27c; border-color:rgba(243,210,124,.45); background:rgba(243,210,124,.1); }
.sev-4 { color:#ffb176; border-color:rgba(255,177,118,.45); background:rgba(255,177,118,.1); }
.sev-5 { color:#ff8f8f; border-color:rgba(255,143,143,.45); background:rgba(255,143,143,.1); }
.sev-6 { color:#fff; border-color:#d9534f; background:rgba(217,83,79,.55); }

.dap-repeat { display:flex; flex-direction:column; gap:14px; }
.dap-repeat-row { display:grid; grid-template-columns:64px 300px 1fr; align-items:center; gap:20px; padding:16px 22px; border-radius:14px;
  background:rgba(255,255,255,.045); border:1px solid rgba(255,255,255,.08); }
.dap-repeat-n { width:52px; height:52px; border-radius:50%; display:grid; place-items:center; font-family:'Playfair Display',serif; font-size:24px;
  color:var(--ink); background:linear-gradient(140deg, var(--gold2), var(--gold)); }
.dap-repeat-what { display:flex; flex-wrap:wrap; }

.dap-footer { position:absolute; left:80px; right:80px; bottom:32px; display:flex; justify-content:space-between; font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:rgba(170,180,204,.7); z-index:3; }
.dap-progress { position:fixed; left:0; right:0; top:0; height:3px; background:rgba(255,255,255,.06); }
.dap-progress div { height:100%; background:linear-gradient(90deg, #a8822f, var(--gold2)); transition:width .5s cubic-bezier(.2,.7,.2,1); }
.dap-controls { position:fixed; left:50%; bottom:18px; transform:translateX(-50%); display:flex; align-items:center; gap:10px; padding:8px 12px;
  border-radius:40px; background:rgba(6,12,28,.75); border:1px solid rgba(201,162,74,.25); backdrop-filter:blur(8px); transition:opacity .4s; z-index:10; }
.dap-root.is-idle .dap-controls { opacity:0; pointer-events:none; }
.dap-root.is-idle { cursor:none; }
.dap-controls button { background:none; border:1px solid rgba(255,255,255,.15); color:var(--ivory); border-radius:20px; height:32px; min-width:32px; font-size:18px; cursor:pointer; font-family:inherit; }
.dap-controls button:hover:not(:disabled) { border-color:var(--gold); color:var(--gold2); }
.dap-controls button:disabled { opacity:.3; cursor:default; }
.dap-controls .dap-wide { font-size:13px; padding:0 14px; }
.dap-dots { display:flex; gap:6px; padding:0 6px; max-width:40vw; overflow:hidden; }
.dap-dots button { width:8px; height:8px; min-width:8px; padding:0; border-radius:50%; border:none; background:rgba(255,255,255,.25); }
.dap-dots button.on { background:var(--gold); width:22px; border-radius:5px; }
`;
