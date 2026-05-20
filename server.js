// ============================================================
//  mijnwarmevloer.nl — server
//  Serveert de statische website én verwerkt het offerteformulier
//  via Resend (https://resend.com).
// ============================================================

import express from 'express';
import { Resend } from 'resend';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 8080;

// ---- Configuratie via environment variables (ingesteld in Railway) ----
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_TO = process.env.MAIL_TO || 'hallo@mijnwarmevloer.nl';     // waar aanvragen heen gaan
const MAIL_FROM = process.env.MAIL_FROM || 'onboarding@resend.dev';  // afzender (zie README over domeinverificatie)

if (!RESEND_API_KEY) {
  console.warn('⚠️  RESEND_API_KEY is niet ingesteld — het formulier zal falen tot deze env var is toegevoegd in Railway.');
}

const resend = new Resend(RESEND_API_KEY);

// ---- Middleware ----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simpele in-memory rate limiter: max 5 inzendingen per IP per 10 minuten
const submissions = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const max = 5;
  const entry = submissions.get(ip) || [];
  const recent = entry.filter(t => now - t < windowMs);
  recent.push(now);
  submissions.set(ip, recent);
  return recent.length <= max;
}

// ---- Helper: HTML-escape om injectie in de mail te voorkomen ----
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- Endpoint: offerteformulier ----
app.post('/api/offerte', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'onbekend';

  // Honeypot: bots vullen vaak verborgen velden in
  if (req.body._gotcha) {
    return res.status(200).json({ ok: true }); // doe alsof het lukte, negeer stilletjes
  }

  if (!rateLimit(ip)) {
    return res.status(429).json({ ok: false, error: 'Te veel aanvragen. Probeer het over een paar minuten opnieuw.' });
  }

  const { naam, telefoon, email, postcode, systeem, oppervlak, situatie, bericht } = req.body;

  // Basisvalidatie
  if (!naam || !email || !telefoon) {
    return res.status(400).json({ ok: false, error: 'Vul naam, telefoon en e-mail in.' });
  }

  // Bouw de e-mail
  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #1E1612;">
      <h2 style="color: #C2562E; font-weight: 600;">Nieuwe offerte-aanvraag</h2>
      <table style="width: 100%; border-collapse: collapse; font-size: 15px;">
        <tr><td style="padding: 8px 0; color: #4A3B33; width: 160px;">Naam</td><td style="padding: 8px 0; font-weight: 500;">${esc(naam)}</td></tr>
        <tr><td style="padding: 8px 0; color: #4A3B33;">Telefoon</td><td style="padding: 8px 0; font-weight: 500;">${esc(telefoon)}</td></tr>
        <tr><td style="padding: 8px 0; color: #4A3B33;">E-mail</td><td style="padding: 8px 0; font-weight: 500;">${esc(email)}</td></tr>
        <tr><td style="padding: 8px 0; color: #4A3B33;">Postcode</td><td style="padding: 8px 0;">${esc(postcode) || '—'}</td></tr>
        <tr><td style="padding: 8px 0; color: #4A3B33;">Soort systeem</td><td style="padding: 8px 0;">${esc(systeem) || '—'}</td></tr>
        <tr><td style="padding: 8px 0; color: #4A3B33;">Oppervlak (m²)</td><td style="padding: 8px 0;">${esc(oppervlak) || '—'}</td></tr>
        <tr><td style="padding: 8px 0; color: #4A3B33;">Situatie</td><td style="padding: 8px 0;">${esc(situatie) || '—'}</td></tr>
      </table>
      <div style="margin-top: 16px; padding: 16px; background: #F4ECE0; border-radius: 8px;">
        <div style="color: #4A3B33; font-size: 13px; margin-bottom: 6px;">Aanvullende informatie</div>
        <div style="white-space: pre-wrap;">${esc(bericht) || '—'}</div>
      </div>
      <p style="margin-top: 20px; font-size: 13px; color: #A89684;">Verzonden via het offerteformulier op mijnwarmevloer.nl</p>
    </div>
  `;

  try {
    const { error } = await resend.emails.send({
      from: `mijnwarmevloer.nl <${MAIL_FROM}>`,
      to: [MAIL_TO],
      replyTo: email,                       // antwoorden gaan direct naar de klant
      subject: `Nieuwe offerte-aanvraag — ${naam}`,
      html,
    });

    if (error) {
      console.error('Resend-fout:', error);
      return res.status(502).json({ ok: false, error: 'Versturen mislukte. Bel ons gerust op 06-46150160.' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Serverfout:', err);
    return res.status(500).json({ ok: false, error: 'Er ging iets mis. Bel ons gerust op 06-46150160.' });
  }
});

// ---- Vind de map met de website-bestanden ----
// Werkt of de HTML's nu in /public staan óf in de hoofdmap (root).
import fs from 'fs';
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;
console.log(`📁 Website-bestanden worden geserveerd uit: ${PUBLIC_DIR}`);

// ---- Statische bestanden serveren (de website zelf) ----
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],   // /contact werkt net als /contact.html
}));

// ---- Fallback: onbekende route → homepage ----
app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server draait op poort ${PORT}`);
});
