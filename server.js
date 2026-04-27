const express = require('express');
const cors    = require('cors');
const app     = express();

app.use(cors());
app.use(express.json());

// ── In-memory stores ────────────────────────────────────────────
let deals     = [];
let investors = [];
let letters   = [];

// ── Health / ping ───────────────────────────────────────────────
app.get('/',         (req, res) => res.json({ status: 'ok', service: 'propertyin28days-backend' }));
app.get('/api/ping', (req, res) => res.json({ pong: true, time: new Date().toISOString() }));

// ── DEALS ───────────────────────────────────────────────────────
app.get('/api/deals', (req, res) => res.json(deals));

app.post('/api/deals', (req, res) => {
  const { purchase, refurb = 0, value } = req.body;
  if (!purchase || !value) return res.status(400).json({ error: 'purchase and value required' });
  const totalCost = Number(purchase) + Number(refurb);
  const profit    = Number(value) - totalCost;
  const roi       = totalCost > 0 ? parseFloat((profit / totalCost * 100).toFixed(2)) : 0;
  const deal      = { id: Date.now(), purchase: Number(purchase), refurb: Number(refurb), value: Number(value), totalCost, profit, roi, createdAt: new Date().toISOString() };
  deals.push(deal);
  res.json(deal);
});

// ── INVESTORS ───────────────────────────────────────────────────
app.get('/api/investors', (req, res) => res.json(investors));

app.post('/api/investors', (req, res) => {
  const { name, email, budget } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  const investor = { id: Date.now(), name, email, budget: Number(budget) || 0, createdAt: new Date().toISOString() };
  investors.push(investor);
  res.json(investor);
});

// ── LETTERS ─────────────────────────────────────────────────────
app.get('/api/letters', (req, res) => res.json(letters));

app.post('/api/letters/generate', (req, res) => {
  const { name, address, ref, backendId } = req.body;
  const letter = { id: Date.now(), name, address, ref: ref || backendId || null, sentAt: new Date().toISOString() };
  letters.push(letter);
  res.json(letter);
});

// ── LISTINGS (CourtServe placeholder) ──────────────────────────
app.get('/api/listings', (req, res) => res.json([]));

// ── START ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`propertyin28days backend running on port ${PORT}`));
