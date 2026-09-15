const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { buildManualPdf } = require('../lib/manualPdf');

const router = express.Router();
const ROUTE = '/process-flow';

// The Manual, as a PDF.
//
// GATED ON can_view, NOT can_print. The convention here is that printed output needs can_print,
// and for a Job Order that is right -- the printed sheet goes to the production floor. A manual is
// reference material somebody is already reading on screen, and saving it as a PDF reveals nothing
// new. On the droplet 47 people can open this page and 2 hold can_print, so the stricter gate would
// lock 45 of them out of a copy of something already in front of them.
//
// THE CLIENT SENDS THE LAYOUT. The elbow routing that draws the connectors lives in ProcessFlow.jsx
// and is genuinely fiddly; a second implementation here would drift from the chart on screen, and
// this PDF is meant to BE that chart. So the browser sends each edge's finished SVG path and the
// node boxes it already computed, and this renders them. See lib/manualPdf.js.
//
// That makes the body the only input, so it is bounded: a manual is tens of kilobytes, and nothing
// here is stored or echoed back to anybody else.
const MAX_NODES = 400;
const MAX_EDGES = 800;

router.post('/pdf', requireAuth, requirePermission(ROUTE, 'can_view'), async (req, res, next) => {
  try {
    const flow = req.body || {};
    const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
    const edges = Array.isArray(flow.edges) ? flow.edges : [];

    if (!nodes.length) return res.status(400).json({ error: 'There is nothing to put in the PDF.' });
    if (nodes.length > MAX_NODES || edges.length > MAX_EDGES) {
      return res.status(413).json({ error: 'That workflow is too large to render.' });
    }
    if (!flow.canvas?.w || !flow.canvas?.h) {
      return res.status(400).json({ error: 'The chart has no size.' });
    }

    const pdf = await buildManualPdf(flow);

    const name = String(flow.title || 'workflow').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name || 'workflow'}-manual.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    return res.end(pdf);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
