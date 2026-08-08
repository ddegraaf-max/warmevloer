// ============================================================
//  mijnwarmevloer.nl — server (met spam-bescherming)
//  Serveert de statische website én verwerkt het offerteformulier
//  via Resend. Beschermd door 6 lagen + Cloudflare Turnstile.
// ============================================================

import express from 'express';
import { Resend } from 'resend';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

// ---- Versienummer (uit package.json) ----
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const APP_VERSION = pkg.version;
const BUILD_TIME = new Date().toISOString();
console.log(`🏷️  mijnwarmevloer.nl versie ${APP_VERSION} — build ${BUILD_TIME}`);

// ---- Configuratie ----
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_TO = process.env.MAIL_TO || 'hallo@mijnwarmevloer.nl';
const MAIL_FROM = process.env.MAIL_FROM || 'onboarding@resend.dev';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const FORM_SIGNING_SECRET = process.env.FORM_SIGNING_SECRET ||
  crypto.randomBytes(32).toString('hex'); // fallback voor lokaal gebruik

if (!RESEND_API_KEY) {
  console.warn('⚠️  RESEND_API_KEY niet ingesteld — formulier zal falen tot Variables zijn ingevuld in Railway.');
}
if (!TURNSTILE_SECRET) {
  console.warn('⚠️  TURNSTILE_SECRET niet ingesteld — Turnstile-verificatie staat uit. Zie README voor setup.');
}

const resend = new Resend(RESEND_API_KEY);

// ---- Middleware ----
app.use(express.json({ limit: '10kb' }));        // beperk payload-grootte
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Zet op alle responses een X-App-Version header — handig om via DevTools te checken
app.use((req, res, next) => {
  res.set('X-App-Version', APP_VERSION);
  next();
});

// ---- Version endpoint (voor snelle check: bezoek /version) ----
app.get(['/version', '/api/version'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ version: APP_VERSION, build: BUILD_TIME });
});

// ---- 301-redirect voor verwijderde pagina ----
app.get(['/projecten', '/projecten.html'], (req, res) => {
  res.redirect(301, '/');
});

// ============================================================
//  SPAM-BESCHERMING — 6 lagen + Turnstile
// ============================================================

// Rate limiter store: { ip → { hits: [timestamps], blocked_until: number } }
const rateStore = new Map();
const REQUESTS_PER_10MIN = 5;
const REQUESTS_PER_HOUR = 10;
const REQUESTS_PER_DAY = 20;

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateStore.get(ip) || { hits: [], blockedUntil: 0 };

  // Permanente block actief?
  if (entry.blockedUntil > now) {
    return { ok: false, reason: 'temporarily blocked' };
  }

  // Houd alleen hits van laatste 24 uur bij
  entry.hits = entry.hits.filter(t => now - t < 24 * 60 * 60 * 1000);

  const last10min = entry.hits.filter(t => now - t < 10 * 60 * 1000).length;
  const lastHour = entry.hits.filter(t => now - t < 60 * 60 * 1000).length;
  const lastDay = entry.hits.length;

  if (last10min >= REQUESTS_PER_10MIN || lastHour >= REQUESTS_PER_HOUR || lastDay >= REQUESTS_PER_DAY) {
    return { ok: false, reason: 'rate limited' };
  }

  entry.hits.push(now);
  rateStore.set(ip, entry);
  return { ok: true };
}

// Periodiek opschonen om geheugen niet te laten groeien
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateStore.entries()) {
    entry.hits = entry.hits.filter(t => now - t < 24 * 60 * 60 * 1000);
    if (entry.hits.length === 0 && entry.blockedUntil < now) {
      rateStore.delete(ip);
    }
  }
}, 60 * 60 * 1000); // elk uur

// ---- LAAG 3: ondertekende tijd-token ----
// Het formulier krijgt bij laden een token { timestamp, signature }.
// Bij submit checken we: bestaat het, klopt de handtekening, niet ouder dan 4u, niet jonger dan 2s.
function makeFormToken() {
  const ts = Date.now();
  const sig = crypto.createHmac('sha256', FORM_SIGNING_SECRET)
    .update(String(ts))
    .digest('hex');
  return `${ts}.${sig}`;
}

function verifyFormToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing token' };
  const [tsStr, sig] = token.split('.');
  if (!tsStr || !sig) return { ok: false, reason: 'malformed token' };

  const expectedSig = crypto.createHmac('sha256', FORM_SIGNING_SECRET)
    .update(tsStr)
    .digest('hex');

  // Timing-safe vergelijken
  if (sig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return { ok: false, reason: 'invalid signature' };
  }

  const ts = parseInt(tsStr, 10);
  const age = Date.now() - ts;
  if (age < 2000) return { ok: false, reason: 'too fast (< 2s)' };          // LAAG 1: minimale invultijd
  if (age > 4 * 60 * 60 * 1000) return { ok: false, reason: 'token expired' }; // > 4 uur oud
  return { ok: true };
}

// ---- LAAG 4: content-spamfilter ----
const SPAM_PATTERNS = [
  /\b(viagra|cialis|casino|crypto|bitcoin|forex|loan|payday|seo services|backlinks|porn)\b/i,
  /\b(make .{0,10}money|earn .{0,10}\$|work from home|click here|buy now)\b/i,
  /https?:\/\/[^\s]{4,}/gi,        // URLs in vrije tekst — bijna altijd spam in een offerteformulier
  /<a\s+href/i,                     // HTML-link tags
  /\[url[=\]]/i,                    // BBCode-links
];

function checkSpamContent(data) {
  const text = `${data.naam || ''} ${data.bericht || ''} ${data.situatie || ''}`;
  const reasons = [];

  // Spam-trefwoorden / patronen
  for (const re of SPAM_PATTERNS) {
    if (re.test(text)) { reasons.push('spam pattern'); break; }
  }

  // Te veel hoofdletters (>60% en minstens 20 tekens)
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 20) {
    const upper = letters.replace(/[^A-Z]/g, '').length;
    if (upper / letters.length > 0.6) reasons.push('excessive caps');
  }

  // Niet-Latijns schrift in een Nederlands offerteformulier (Cyrillisch, Chinees, Arabisch, etc.)
  // We staan accenten en gewone Latijnse tekens toe. Een paar emoji's mogen.
  const nonLatin = text.replace(/[\s\d\p{Script=Latin}\p{P}\p{S}]/gu, '');
  if (nonLatin.length > 3) reasons.push('non-latin script');

  // Te veel links of @-tekens (vaak spammers)
  const atCount = (text.match(/@/g) || []).length;
  if (atCount > 3) reasons.push('too many @ signs');

  // Lege/onzin naam (bv. één teken)
  if ((data.naam || '').trim().length < 2) reasons.push('name too short');

  return reasons;
}

// ---- Turnstile-verificatie ----
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return { ok: true, skipped: true };  // setup nog niet klaar — niet blokkeren
  if (!token) return { ok: false, reason: 'turnstile token missing' };

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    const data = await res.json();
    return data.success ? { ok: true } : { ok: false, reason: 'turnstile failed', detail: data['error-codes'] };
  } catch (err) {
    console.error('Turnstile error:', err);
    return { ok: false, reason: 'turnstile error' };
  }
}

// ---- Helper: HTML-escape ----
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
//  Endpoints
// ============================================================

// Geeft een vers form-token aan de client (LAAG 3)
app.get('/api/form-token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ token: makeFormToken() });
});

// ============================================================
//  OFFERTE-TOOL: prijstabel + BAG-lookup + offerte-generatie
// ============================================================

// Marktconforme richtprijzen per m² (incl. btw, incl. aanleg en materiaal).
// Prijzen komen uit de website — één bron van waarheid.
const PRICING = {
  'watergedragen-nat':      { label: 'Watergedragen — nat systeem (nieuwbouw)', min: 30, max: 50 },
  'watergedragen-droog':    { label: 'Watergedragen — droogbouw (renovatie)',   min: 35, max: 65 },
  'watergedragen-frezen':   { label: 'Watergedragen — infrezen in bestaande vloer', min: 30, max: 45 },
  'elektrisch-tegels':      { label: 'Elektrisch — matten onder tegels',        min: 60, max: 70 },
  'elektrisch-folie':       { label: 'Elektrisch — foliesysteem onder laminaat', min: 50, max: 75 },
};
// Meerprijs voor het dichtsmeren/egaliseren van sleuven bij infrezen (per m²)
const FREZEN_MEERPRIJS = { '1mm': 4, '2mm': 7, 'meer': 14 };
// Percentage van BAG-oppervlakte dat we standaard aanhouden als verwarmbaar
const VERWARMBAAR_FACTOR = 0.85;

function berekenPrijs({ systeem, m2, frezenLaagdikte }) {
  const p = PRICING[systeem];
  if (!p) return null;
  const base_min = p.min * m2;
  const base_max = p.max * m2;
  let extra = 0;
  if (systeem === 'watergedragen-frezen' && frezenLaagdikte && FREZEN_MEERPRIJS[frezenLaagdikte]) {
    extra = FREZEN_MEERPRIJS[frezenLaagdikte] * m2;
  }
  return {
    min: Math.round((base_min + extra) / 50) * 50,   // afronden op €50
    max: Math.round((base_max + extra) / 50) * 50,
    perM2: `€${p.min} — €${p.max}`,
    label: p.label,
    m2Used: m2,
    meerprijs: extra > 0 ? Math.round(extra) : null,
  };
}

// ---- BAG-lookup via PDOK Locatieserver + BAG API ----
// Geeft de bezoeker een gebruiksoppervlakte terug op basis van postcode + huisnummer.
// Werkt met de gratis openbare PDOK-endpoints (geen key nodig).
app.post('/api/adres-lookup', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'onbekend';
  const rate = checkRateLimit(ip);
  if (!rate.ok) return res.status(429).json({ ok: false, error: 'Te veel aanvragen — probeer over een paar minuten opnieuw.' });

  const { postcode, huisnummer, toevoeging } = req.body || {};
  if (!postcode || !huisnummer) {
    return res.status(400).json({ ok: false, error: 'Vul postcode en huisnummer in.' });
  }

  // Normaliseer postcode: "1234 AB" of "1234ab" → "1234AB"
  const pcClean = String(postcode).replace(/\s+/g, '').toUpperCase();
  if (!/^\d{4}[A-Z]{2}$/.test(pcClean)) {
    return res.status(400).json({ ok: false, error: 'Postcode klopt niet. Formaat: 1234 AB.' });
  }
  const hn = String(huisnummer).trim();
  const tv = (toevoeging || '').trim();

  try {
    // Stap 1: adres opzoeken in Locatieserver
    const q = `postcode:${pcClean} AND huisnummer:${hn}${tv ? ' AND huisletter:' + tv[0] : ''}`;
    const url = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=${encodeURIComponent(q)}&fq=type:adres&rows=5&fl=id,weergavenaam,adresseerbaarobject_id,straatnaam,huisnummer,huisletter,huistoevoeging,postcode,woonplaatsnaam`;
    const lookupRes = await fetch(url);
    if (!lookupRes.ok) throw new Error('Locatieserver HTTP ' + lookupRes.status);
    const lookupData = await lookupRes.json();
    const docs = lookupData?.response?.docs || [];
    if (docs.length === 0) {
      return res.json({ ok: false, notFound: true, error: 'Dit adres kunnen we niet vinden. Vul de oppervlakte hieronder handmatig in.' });
    }
    const doc = docs[0];
    const adresseerbaarObjectId = doc.adresseerbaarobject_id;

    // Stap 2: oppervlakte ophalen via BAG-API (Haal Centraal)
    let oppervlakte = null;
    if (adresseerbaarObjectId) {
      try {
        const bagRes = await fetch(`https://api.pdok.nl/lv/bag/individuelebevragingen/v2/verblijfsobjecten/${adresseerbaarObjectId}`, {
          headers: { 'Accept': 'application/hal+json', 'Accept-Crs': 'epsg:28992' }
        });
        if (bagRes.ok) {
          const bagData = await bagRes.json();
          oppervlakte = bagData?.verblijfsobject?.verblijfsobject?.oppervlakte
                      || bagData?.oppervlakte
                      || null;
        }
      } catch (e) {
        // BAG-call kan falen (rate limit, onbekend object); we hebben nog het adres, dus we tonen dat en laten de gebruiker m² zelf invullen
        console.warn('BAG-lookup failed:', e.message);
      }
    }

    return res.json({
      ok: true,
      adres: {
        straat: doc.straatnaam,
        huisnummer: doc.huisnummer + (doc.huisletter || '') + (doc.huistoevoeging ? '-' + doc.huistoevoeging : ''),
        postcode: doc.postcode,
        plaats: doc.woonplaatsnaam,
        weergavenaam: doc.weergavenaam,
      },
      oppervlakteBag: oppervlakte,
      verwarmbaarSuggestie: oppervlakte ? Math.round(oppervlakte * VERWARMBAAR_FACTOR) : null,
    });
  } catch (err) {
    console.error('Adres-lookup fout:', err);
    return res.status(502).json({ ok: false, error: 'De adresservice reageert niet. Vul de oppervlakte handmatig in.' });
  }
});

// ---- Offerte-tool: schatting berekenen + e-mail versturen ----
app.post('/api/tool-offerte', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'onbekend';
  const respondSilentOk = () => res.json({ ok: true });

  // Spam-lagen 2, 3, 5
  if (req.body._gotcha || req.body.website || req.body.url || req.body.phone_number_2) {
    console.log(`[spam-tool] honeypot — ip=${ip}`); return respondSilentOk();
  }
  const rate = checkRateLimit(ip);
  if (!rate.ok) { console.log(`[spam-tool] rate — ip=${ip}`); return respondSilentOk(); }
  const tokenCheck = verifyFormToken(req.body._formToken);
  if (!tokenCheck.ok) { console.log(`[spam-tool] token — ${tokenCheck.reason}`); return respondSilentOk(); }

  const {
    naam, telefoon, email,
    postcode, huisnummer, toevoeging, plaats, straat,
    m2, systeem, frezenLaagdikte,
    huidigeVloer, aanvullend
  } = req.body;

  if (!naam || !email || !telefoon) return res.status(400).json({ ok: false, error: 'Vul naam, telefoon en e-mail in.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Vul een geldig e-mailadres in.' });
  const m2num = parseInt(m2, 10);
  if (!m2num || m2num < 5 || m2num > 500) return res.status(400).json({ ok: false, error: 'Vul een geldig aantal m² in (5–500).' });
  if (!PRICING[systeem]) return res.status(400).json({ ok: false, error: 'Kies een systeem.' });

  // Content-spamfilter
  const spamReasons = checkSpamContent({ naam, bericht: aanvullend, situatie: huidigeVloer });
  if (spamReasons.length > 0) { console.log(`[spam-tool] content — ${spamReasons.join(', ')}`); return respondSilentOk(); }

  // Turnstile
  const tsCheck = await verifyTurnstile(req.body['cf-turnstile-response'], ip);
  if (!tsCheck.ok) { console.log(`[spam-tool] turnstile — ${tsCheck.reason}`); return respondSilentOk(); }

  // Bereken de prijs
  const prijs = berekenPrijs({ systeem, m2: m2num, frezenLaagdikte });
  if (!prijs) return res.status(400).json({ ok: false, error: 'Systeem onbekend.' });

  const adresRegel = [straat, huisnummer + (toevoeging || ''), postcode, plaats].filter(Boolean).join(' ');
  const eurFmt = (n) => '€' + n.toLocaleString('nl-NL');

  // E-mail naar Daniël (met alle gegevens)
  const htmlIntern = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 620px; margin: 0 auto; color: #1E1612;">
      <h2 style="color: #C2562E; font-weight: 600; margin-bottom: 4px;">Nieuwe offerte-tool aanvraag</h2>
      <p style="color: #4A3B33; margin-top: 0;">Schatting op basis van tool-invoer</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 15px; margin-top: 20px;">
        <tr><td style="padding: 8px 0; color: #4A3B33; width: 170px;">Naam</td><td style="padding: 8px 0; font-weight: 500;">${esc(naam)}</td></tr>
        <tr><td style="padding: 8px 0; color: #4A3B33;">Telefoon</td><td style="padding: 8px 0; font-weight: 500;">${esc(telefoon)}</td></tr>
        <tr><td style="padding: 8px 0; color: #4A3B33;">E-mail</td><td style="padding: 8px 0; font-weight: 500;">${esc(email)}</td></tr>
        <tr><td style="padding: 8px 0; color: #4A3B33;">Adres</td><td style="padding: 8px 0;">${esc(adresRegel) || '—'}</td></tr>
        <tr><td style="padding: 8px 0; color: #4A3B33;">Oppervlak</td><td style="padding: 8px 0; font-weight: 500;">${m2num} m²</td></tr>
        <tr><td style="padding: 8px 0; color: #4A3B33;">Systeem</td><td style="padding: 8px 0;">${esc(prijs.label)}</td></tr>
        ${frezenLaagdikte ? `<tr><td style="padding: 8px 0; color: #4A3B33;">Laagdikte (frezen)</td><td style="padding: 8px 0;">${esc(frezenLaagdikte)}</td></tr>` : ''}
        <tr><td style="padding: 8px 0; color: #4A3B33;">Huidige vloer</td><td style="padding: 8px 0;">${esc(huidigeVloer) || '—'}</td></tr>
      </table>
      <div style="margin-top: 20px; padding: 20px; background: linear-gradient(135deg, #F4ECE0 0%, #EADFCD 100%); border-radius: 12px;">
        <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.15em; color: #C2562E; margin-bottom: 8px;">SCHATTING (klant heeft dit gezien)</div>
        <div style="font-family: 'Fraunces', Georgia, serif; font-style: italic; font-size: 30px; color: #1E1612;">${eurFmt(prijs.min)} — ${eurFmt(prijs.max)}</div>
        <div style="font-size: 13px; color: #4A3B33; margin-top: 6px;">Op basis van ${m2num} m² × ${prijs.perM2}/m²${prijs.meerprijs ? ` + €${prijs.meerprijs} meerprijs frezen` : ''}</div>
      </div>
      ${aanvullend ? `<div style="margin-top: 16px; padding: 16px; background: #F4ECE0; border-radius: 8px;"><div style="color: #4A3B33; font-size: 13px; margin-bottom: 6px;">Aanvullende informatie</div><div style="white-space: pre-wrap;">${esc(aanvullend)}</div></div>` : ''}
      <p style="margin-top: 24px; font-size: 13px; color: #A89684;">Aanvraag via de offerte-tool op mijnwarmevloer.nl</p>
    </div>
  `;

  // E-mail naar de klant (nette bevestiging met de schatting)
  const htmlKlant = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 620px; margin: 0 auto; color: #1E1612;">
      <h2 style="color: #C2562E; font-weight: 600;">Bedankt voor je aanvraag, ${esc(naam.split(' ')[0])}</h2>
      <p style="color: #4A3B33; font-size: 15px; line-height: 1.6;">We hebben je aanvraag ontvangen en bekijken 'm persoonlijk. <strong>Binnen 2 werkdagen</strong> nemen we contact op met een definitieve offerte op maat.</p>
      <div style="margin: 24px 0; padding: 24px; background: linear-gradient(135deg, #F4ECE0 0%, #EADFCD 100%); border-radius: 12px;">
        <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.15em; color: #C2562E; margin-bottom: 10px;">Richtprijs op basis van je invoer</div>
        <div style="font-family: 'Fraunces', Georgia, serif; font-style: italic; font-size: 34px; color: #1E1612; line-height: 1;">${eurFmt(prijs.min)} — ${eurFmt(prijs.max)}</div>
        <div style="font-size: 14px; color: #4A3B33; margin-top: 10px;">${prijs.label}<br>${m2num} m² × ${prijs.perM2}/m² incl. btw, incl. aanleg${prijs.meerprijs ? `<br>+ €${prijs.meerprijs} meerprijs voor dichtsmeren/egaliseren van sleuven` : ''}</div>
      </div>
      <p style="color: #4A3B33; font-size: 14px; line-height: 1.6;">Dit is een <strong>indicatie</strong>. De definitieve prijs bepalen we na een kort intakegesprek — omdat elke situatie anders is (staat van de vloer, warmtebron, gewenste opleverdatum).</p>
      <div style="margin: 32px 0; padding-top: 20px; border-top: 1px solid #D9C8B0;">
        <p style="color: #4A3B33; font-size: 14px; margin: 0 0 4px;">Vragen of liever direct contact?</p>
        <p style="font-size: 15px; margin: 0;"><strong>Daniel de Graaf</strong> · <a href="tel:+31646150160" style="color: #C2562E;">06-46150160</a> · <a href="mailto:hallo@mijnwarmevloer.nl" style="color: #C2562E;">hallo@mijnwarmevloer.nl</a></p>
      </div>
      <p style="font-size: 12px; color: #A89684; margin-top: 40px;">mijnwarmevloer.nl — een handelsnaam van Creditline BV · KvK 59683198</p>
    </div>
  `;

  try {
    // Beide mails parallel versturen
    await Promise.all([
      resend.emails.send({
        from: `mijnwarmevloer.nl <${MAIL_FROM}>`,
        to: [MAIL_TO],
        replyTo: email,
        subject: `Offerte-tool aanvraag — ${naam} — ${m2num} m² — ${eurFmt(prijs.min)}–${eurFmt(prijs.max)}`,
        html: htmlIntern,
      }),
      resend.emails.send({
        from: `mijnwarmevloer.nl <${MAIL_FROM}>`,
        to: [email],
        replyTo: MAIL_TO,
        subject: `Je richtprijs voor vloerverwarming — mijnwarmevloer.nl`,
        html: htmlKlant,
      }),
    ]);
    return res.json({ ok: true, prijs });
  } catch (err) {
    console.error('E-mail versturen mislukte:', err);
    // We hebben de gegevens wél binnen; geef klant een vriendelijke melding
    return res.status(502).json({ ok: false, error: 'Het versturen mislukte. Bel gerust op 06-46150160 — dan pakken we het direct op.' });
  }
});


// Contactformulier-endpoint (het bestaande formulier op /contact)
app.post('/api/offerte', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress || 'onbekend';

  // ---- LAAG 6: STIL FALEN ----
  // Voor bots gedragen we ons alsof het altijd lukt. Pas op het einde bepalen we of we echt verzenden.
  // We geven alleen bij échte gebruikersfouten (validatie van zichtbare velden) een foutmelding terug.
  const respondSilentOk = () => res.json({ ok: true });

  // ---- LAAG 2: HONEYPOTS ----
  // Verborgen velden die bots geneigd zijn in te vullen. Echte gebruikers nooit.
  if (req.body._gotcha || req.body.website || req.body.url || req.body.phone_number_2) {
    console.log(`[spam] honeypot ingevuld — ip=${ip}`);
    return respondSilentOk();
  }

  // ---- LAAG 5: RATE LIMIT ----
  const rate = checkRateLimit(ip);
  if (!rate.ok) {
    console.log(`[spam] rate limited — ip=${ip} reden=${rate.reason}`);
    return respondSilentOk();
  }

  // ---- LAAG 3: FORM TOKEN (timing + replay-bescherming) ----
  const tokenCheck = verifyFormToken(req.body._formToken);
  if (!tokenCheck.ok) {
    console.log(`[spam] token-check faalde — ip=${ip} reden=${tokenCheck.reason}`);
    return respondSilentOk();
  }

  // ---- Basisvalidatie (échte gebruikersfouten — geef wél feedback) ----
  const { naam, telefoon, email, postcode, systeem, oppervlak, situatie, bericht } = req.body;
  if (!naam || !email || !telefoon) {
    return res.status(400).json({ ok: false, error: 'Vul naam, telefoon en e-mail in.' });
  }
  // Simpele e-mail-vorm check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Vul een geldig e-mailadres in.' });
  }

  // ---- LAAG 4: CONTENT-SPAMFILTER ----
  const spamReasons = checkSpamContent(req.body);
  if (spamReasons.length > 0) {
    console.log(`[spam] content geweigerd — ip=${ip} redenen=${spamReasons.join(', ')}`);
    return respondSilentOk();
  }

  // ---- TURNSTILE (Cloudflare CAPTCHA-vervanger) ----
  const tsCheck = await verifyTurnstile(req.body['cf-turnstile-response'], ip);
  if (!tsCheck.ok) {
    console.log(`[spam] turnstile faalde — ip=${ip} reden=${tsCheck.reason}`);
    return respondSilentOk();
  }

  // ---- Alle lagen gepasseerd → e-mail verzenden ----
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
      replyTo: email,
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

// ============================================================
//  Statische bestanden
// ============================================================
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;
console.log(`📁 Website-bestanden uit: ${PUBLIC_DIR}`);

// Vervang {{VERSION}} in HTML-bestanden door het echte versienummer.
// Voor statische assets (css/js/img) doen we niets — alleen HTML wordt aangepast.
app.get(/\.html$|\/$/, (req, res, next) => {
  const urlPath = req.path === '/' ? '/index.html' : req.path;
  const filePath = path.join(PUBLIC_DIR, urlPath);
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return next();  // bestand niet gevonden → laat static handler het afhandelen
    const rendered = html
      .replace(/\{\{VERSION\}\}/g, APP_VERSION)
      .replace(/\{\{BUILD_TIME\}\}/g, BUILD_TIME);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(rendered);
  });
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server draait op poort ${PORT}`);
});
