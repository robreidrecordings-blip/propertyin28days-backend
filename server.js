const express     = require('express');
const cors        = require('cors');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const PDFDoc      = require('pdfkit');
const axios       = require('axios');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const { createClient } = require('@supabase/supabase-js');
const stripe      = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

// ── Supabase ─────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Auth middleware ───────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Health ────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'propertyin28days' }));

// ── LOGIN ─────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const { data: user, error } = await supabase
    .from('members')
    .select('*')
    .eq('username', username)
    .single();
  if (error || !user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username: user.username, credits: user.credits });
});

// ── GET MEMBER ────────────────────────────────────────────────────
app.get('/api/me', auth, async (req, res) => {
  const { data: user } = await supabase.from('members').select('username,credits,email').eq('id', req.user.id).single();
  res.json(user);
});

// ── DEALS ─────────────────────────────────────────────────────────
app.get('/api/deals', auth, async (req, res) => {
  const { data } = await supabase.from('deals').select('*').eq('member_id', req.user.id).order('created_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/deals', auth, async (req, res) => {
  const { purchase, refurb = 0, value } = req.body;
  const totalCost = Number(purchase) + Number(refurb);
  const profit = Number(value) - totalCost;
  const roi = totalCost > 0 ? parseFloat((profit / totalCost * 100).toFixed(2)) : 0;
  const { data } = await supabase.from('deals').insert({
    member_id: req.user.id, purchase: Number(purchase), refurb: Number(refurb),
    value: Number(value), total_cost: totalCost, profit, roi
  }).select().single();
  res.json(data);
});

// ── LETTERS ───────────────────────────────────────────────────────
app.get('/api/letters', auth, async (req, res) => {
  const { data } = await supabase.from('letters').select('*').eq('member_id', req.user.id).order('sent_at', { ascending: false });
  res.json(data || []);
});

app.post('/api/letters/send', auth, async (req, res) => {
  const { owner, address, postcode, town, body } = req.body;

  // Check credits
  const { data: member } = await supabase.from('members').select('credits').eq('id', req.user.id).single();
  if (!member || member.credits < 1) return res.status(402).json({ error: 'Insufficient credits' });

  try {
    // Generate PDF
    const pdfPath = path.join(os.tmpdir(), `letter-${Date.now()}.pdf`);
    await new Promise((resolve, reject) => {
      const doc = new PDFDoc({ margin: 72, size: 'A4' });
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);
      doc.fontSize(14).font('Helvetica-Bold').text('Rob Reid Consultants');
      doc.fontSize(11).font('Helvetica').text('Property in 28 Days');
      doc.text('robreidconsultants.com');
      doc.moveDown(2);
      doc.text(new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }));
      doc.moveDown(1);
      doc.fontSize(11).font('Helvetica').text(body, { lineGap: 4, paragraphGap: 8 });
      doc.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');
    fs.unlinkSync(pdfPath);

    // Send via ClickSend
    const credentials = Buffer.from(`${process.env.CLICKSEND_USERNAME}:${process.env.CLICKSEND_KEY}`).toString('base64');
    const csRes = await axios.post(
      'https://rest.clicksend.com/v3/post/letters/send',
      {
        file_contents: pdfBase64,
        recipients: [{
          address_name: owner,
          address_line_1: address.split(',')[0].trim(),
          address_city: town || 'Unknown',
          address_postal_code: postcode,
          address_country: 'GB'
        }]
      },
      { headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' } }
    );

    const msgId = csRes.data?.data?.recipients?.[0]?.message_id || 'sent';

    // Deduct credit
    await supabase.from('members').update({ credits: member.credits - 1 }).eq('id', req.user.id);

    // Log letter
    await supabase.from('letters').insert({
      member_id: req.user.id, owner, address, postcode, clicksend_ref: msgId
    });

    res.json({ success: true, message_id: msgId, credits_remaining: member.credits - 1 });

  } catch (e) {
    console.error('Letter error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Failed to send letter', detail: e.message });
  }
});

// ── STRIPE — buy credits ──────────────────────────────────────────
app.post('/api/credits/checkout', auth, async (req, res) => {
  const { pack } = req.body; // 'starter' | 'pro' | 'unlimited'
  const packs = {
    starter:   { credits: 10,  amount: 2800,  name: '10 Letters' },
    pro:       { credits: 25,  amount: 5900,  name: '25 Letters' },
    unlimited: { credits: 100, amount: 19900, name: '100 Letters' },
  };
  const chosen = packs[pack];
  if (!chosen) return res.status(400).json({ error: 'Invalid pack' });

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'gbp',
        product_data: { name: chosen.name + ' — Property in 28 Days' },
        unit_amount: chosen.amount,
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `https://propertyin28days.net/dashboard.html?credits=success`,
    cancel_url:  `https://propertyin28days.net/dashboard.html?credits=cancelled`,
    metadata: { member_id: req.user.id, credits: chosen.credits }
  });

  res.json({ url: session.url });
});

// ── STRIPE WEBHOOK — add credits after payment ────────────────────
app.post('/api/credits/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { member_id, credits } = session.metadata;
    const { data: member } = await supabase.from('members').select('credits').eq('id', member_id).single();
    if (member) {
      await supabase.from('members').update({ credits: member.credits + parseInt(credits) }).eq('id', member_id);
    }
  }
  res.json({ received: true });
});

// ── INVESTORS ─────────────────────────────────────────────────────
app.get('/api/investors', auth, async (req, res) => {
  const { data } = await supabase.from('investors').select('*').eq('member_id', req.user.id);
  res.json(data || []);
});

app.post('/api/investors', auth, async (req, res) => {
  const { name, email, budget } = req.body;
  const { data } = await supabase.from('investors').insert({ member_id: req.user.id, name, email, budget: Number(budget) || 0 }).select().single();
  res.json(data);
});

// ── START ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`propertyin28days running on port ${PORT}`));
