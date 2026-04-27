const express  = require('express');
const cors     = require('cors');
const PDFDoc   = require('pdfkit');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const app      = express();

app.use(cors());
app.use(express.json());

// ── In-memory stores ─────────────────────────────────────────────
let deals     = [];
let investors = [];
let letters   = [];

// ── Health / ping ────────────────────────────────────────────────
app.get('/',         (req, res) => res.json({ status: 'ok', service: 'propertyin28days-backend' }));
app.get('/api/ping', (req, res) => res.json({ pong: true, time: new Date().toISOString() }));

// ── DEALS ────────────────────────────────────────────────────────
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

// ── INVESTORS ────────────────────────────────────────────────────
app.get('/api/investors', (req, res) => res.json(investors));
app.post('/api/investors', (req, res) => {
  const { name, email, budget } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  const investor = { id: Date.now(), name, email, budget: Number(budget) || 0, createdAt: new Date().toISOString() };
  investors.push(investor);
  res.json(investor);
});

// ── LETTERS LOG ──────────────────────────────────────────────────
app.get('/api/letters', (req, res) => res.json(letters));
app.post('/api/letters/generate', (req, res) => {
  const { name, address, ref, backendId } = req.body;
  const letter = { id: Date.now(), name, address, ref: ref || backendId || null, sentAt: new Date().toISOString() };
  letters.push(letter);
  res.json(letter);
});

// ── LISTINGS ─────────────────────────────────────────────────────
app.get('/api/listings', (req, res) => res.json([]));

// ── PDF GENERATION + CLICKSEND ───────────────────────────────────
app.post('/api/letters/send', async (req, res) => {
  const { owner, address, postcode, town, body, clicksendUsername, clicksendKey } = req.body;

  if (!clicksendUsername || !clicksendKey) {
    return res.status(400).json({ error: 'ClickSend credentials required' });
  }

  try {
    // 1. Generate PDF in memory
    const pdfPath = path.join(os.tmpdir(), `letter-${Date.now()}.pdf`);
    await new Promise((resolve, reject) => {
      const doc  = new PDFDoc({ margin: 72, size: 'A4' });
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

      // Header
      doc.fontSize(14).font('Helvetica-Bold').text('Rob Reid Consultants', { align: 'left' });
      doc.fontSize(11).font('Helvetica').text('Property in 28 Days', { align: 'left' });
      doc.text('robreidconsultants.com', { align: 'left' });
      doc.moveDown(2);

      // Date
      const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
      doc.text(today);
      doc.moveDown(1);

      // Letter body
      doc.fontSize(11).font('Helvetica').text(body || `Dear ${owner},\n\nI am writing regarding your property at ${address}.`, {
        lineGap: 4,
        paragraphGap: 8
      });

      doc.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    // 2. Convert PDF to base64
    const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
    fs.unlinkSync(pdfPath); // clean up

    // 3. Send to ClickSend
    const credentials = Buffer.from(`${clicksendUsername}:${clicksendKey}`).toString('base64');

    const payload = {
      file_contents: pdfBase64,
      recipients: [{
        address_name:        owner,
        address_line_1:      address.split(',')[0].trim(),
        address_city:        town || 'Unknown',
        address_postal_code: postcode,
        address_country:     'GB'
      }]
    };

    const csRes = await axios.post(
      'https://rest.clicksend.com/v3/post/letters/send',
      payload,
      { headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' } }
    );

    const msgId = csRes.data?.data?.recipients?.[0]?.message_id || 'sent';
    letters.push({ id: Date.now(), name: owner, address, ref: msgId, sentAt: new Date().toISOString() });

    res.json({ success: true, message_id: msgId, status: 'queued' });

  } catch (e) {
    console.error('Letter send failed:', e.response?.data || e.message);
    res.status(500).json({ error: 'Failed to send letter', detail: e.message });
  }
});

// ── START ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`propertyin28days backend running on port ${PORT}`));
