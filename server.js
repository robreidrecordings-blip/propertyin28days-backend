require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Low, JSONFile } = require('lowdb');
const path = require('path');
const fs = require('fs').promises;
const fetch = require('node-fetch');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/pdfs', express.static(path.join(__dirname, 'public/letters')));
const PDF_STORAGE = path.join(__dirname, 'public/letters');
fs.mkdir(PDF_STORAGE, { recursive: true }).catch(console.error);

const adapter = new JSONFile(path.join(__dirname, 'db.json'));
const db = new Low(adapter);

async function initDb() {
  await db.read();
  db.data ||= { letters: [], deals: [], investors: [], listings: [] };
  await db.write();
}
initDb();

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token !== process.env.API_TOKEN) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
  }
  next();
};

async function generatePdf(recipient, messageText) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><style>
      body { font-family: 'Georgia', serif; font-size: 14px; line-height: 1.6; max-width: 600px; margin: 40px auto; padding: 20px; color: #1e1e1e; }
      .header { margin-bottom: 30px; border-bottom: 1px solid #ccc; padding-bottom: 10px; }
      .company { font-size: 20px; font-weight: bold; color: #c9a84c; }
      .tagline { font-size: 12px; color: #666; }
      .date { margin-top: 20px; margin-bottom: 30px; }
      .content { margin-bottom: 30px; }
      .signature { margin-top: 40px; }
    </style></head>
    <body>
      <div class="header"><div class="company">Rob Reid Consultants</div><div class="tagline">Property in 28 Days · robreidconsultants.com</div></div>
      <div class="date">${today}</div>
      <div class="salutation">Dear ${recipient.full_name},</div>
      <div class="content">${messageText.replace(/\n/g, '<br/>')}</div>
      <div class="signature">Yours sincerely,<br/><br/>Rob Reid<br/>Principal Consultant</div>
    </body>
    </html>
  `;
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
  await browser.close();
  const filename = `letter_${Date.now()}_${Math.random().toString(36).substr(2, 8)}.pdf`;
  const filePath = path.join(PDF_STORAGE, filename);
  await fs.writeFile(filePath, pdfBuffer);
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return `${baseUrl}/pdfs/${filename}`;
}

async function sendViaClickSend(recipient, messageText, pdfUrl) {
  const payload = {
    file_url: pdfUrl,
    recipients: [{
      address_name: recipient.full_name,
      address_line_1: recipient.address_line_1,
      address_city: recipient.city,
      address_postal_code: recipient.postal_code,
      address_country: recipient.country_code || 'GB',
      custom_string: Date.now().toString()
    }]
  };
  const credentials = Buffer.from(`${process.env.CLICKSEND_USERNAME}:${process.env.CLICKSEND_API_KEY}`).toString('base64');
  const response = await fetch('https://rest.clicksend.com/v3/post/letters/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${credentials}` },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickSend error ${response.status}: ${errorText}`);
  }
  const data = await response.json();
  return {
    providerRef: data?.data?.recipients?.[0]?.message_id || data?.data?.message_id,
    status: 'queued'
  };
}

app.post('/v1/letters', auth, async (req, res) => {
  const { recipient, message, send_now = true } = req.body;
  if (!recipient?.full_name || !recipient?.address_line_1 || !recipient?.postal_code) {
    return res.status(400).json({ error: { code: 'INVALID_ADDRESS', message: 'Missing recipient fields' } });
  }
  const letterId = `ltr_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  const newLetter = { id: letterId, status: 'queued', price: 2.80, currency: 'GBP', estimated_delivery_days: 3, createdAt: new Date().toISOString(), recipient, message };
  db.data.letters.push(newLetter);
  await db.write();
  let tracking = null;
  if (send_now) {
    try {
      const pdfUrl = await generatePdf(recipient, message);
      const result = await sendViaClickSend(recipient, message, pdfUrl);
      tracking = { provider: 'clicksend', provider_ref: result.providerRef };
      newLetter.status = 'queued';
      newLetter.tracking = tracking;
      await db.write();
    } catch (err) {
      console.error('PDF or ClickSend error:', err);
      newLetter.status = 'failed';
      await db.write();
      return res.status(500).json({ error: { code: 'PROVIDER_ERROR', message: 'Failed to queue letter with provider' } });
    }
  }
  res.status(201).json({ id: letterId, status: newLetter.status, price: newLetter.price, currency: newLetter.currency, estimated_delivery_days: newLetter.estimated_delivery_days });
});

app.get('/v1/letters/:id', auth, async (req, res) => {
  const letter = db.data.letters.find(l => l.id === req.params.id);
  if (!letter) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Letter not found' } });
  res.json({ id: letter.id, status: letter.status, tracking: letter.tracking || null });
});

app.post('/v1/pricing/quote', auth, async (req, res) => {
  const baseCost = 1.00;
  const markup = 1.80;
  res.json({ price: +(baseCost + markup).toFixed(2), currency: 'GBP', breakdown: { base_cost: baseCost, markup: markup } });
});

app.get('/api/listings', auth, async (req, res) => { res.json(db.data.listings); });
app.post('/api/listings/import', auth, async (req, res) => {
  const listings = req.body;
  if (!Array.isArray(listings)) return res.status(400).json({ error: 'Expected array of listings' });
  db.data.listings = listings;
  await db.write();
  res.json({ imported: listings.length });
});
app.post('/api/deals', auth, async (req, res) => {
  const { purchase, refurb, value } = req.body;
  const profit = value - (purchase + refurb);
  const roi = (profit / (purchase + refurb)) * 100;
  const deal = { id: Date.now(), purchase, refurb, value, profit: profit.toFixed(2), roi: roi.toFixed(2), createdAt: new Date().toISOString() };
  db.data.deals.push(deal);
  await db.write();
  res.status(201).json(deal);
});
app.get('/api/deals', auth, async (req, res) => { res.json(db.data.deals); });
app.post('/api/investors', auth, async (req, res) => {
  const { name, email, budget } = req.body;
  const investor = { id: Date.now(), name, email, budget: budget ? Number(budget) : null, createdAt: new Date().toISOString() };
  db.data.investors.push(investor);
  await db.write();
  res.status(201).json(investor);
});
app.get('/api/investors', auth, async (req, res) => { res.json(db.data.investors); });
app.post('/api/letters/generate', auth, async (req, res) => { console.log(`Letter generated for ${req.body.name}`); res.json({ status: 'logged' }); });
app.post('/api/letters/pdf', auth, async (req, res) => {
  const { owner, address, postcode, town, body } = req.body;
  const recipient = { full_name: owner, address_line_1: address, city: town, postal_code: postcode, country_code: 'GB' };
  try {
    const pdfUrl = await generatePdf(recipient, body);
    res.json({ url: pdfUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Backend running on http://localhost:${PORT}`); });