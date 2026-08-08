# mijnwarmevloer.nl

Website + offerteformulier voor **mijnwarmevloer.nl** — een handelsnaam van Creditline BV.
Het formulier verstuurt aanvragen via [Resend](https://resend.com) en is beschermd door
6 lagen anti-spam plus Cloudflare Turnstile.

---

## 📂 Structuur

Alle bestanden staan plat in de hoofdmap:

```
.
├── index.html, contact.html, faq.html,
│   privacy.html, voorwaarden.html        ← de pagina's
├── style.css, script.js                  ← styling + interactie
├── *.svg, *.jpg, *.ico, robots.txt,      ← assets
│   sitemap.xml
├── server.js          ← Node.js-server (statische site + formulier-API)
├── package.json       ← dependencies (express, resend)
├── Dockerfile         ← bouwt de container voor Railway
└── .gitignore
```

---

## ⚙️ Environment variables (instellen in Railway)

| Variabele | Verplicht? | Voorbeeld | Uitleg |
|---|---|---|---|
| `RESEND_API_KEY` | ✅ | `re_xxxxxxxx` | Resend API-key |
| `MAIL_TO` | nee | `hallo@mijnwarmevloer.nl` | Waar aanvragen heen gaan |
| `MAIL_FROM` | nee | `offerte@mijnwarmevloer.nl` | Afzender (na domeinverificatie) |
| `TURNSTILE_SECRET` | ⚠️ aanbevolen | `0x4AAA...` | Cloudflare Turnstile secret key |
| `FORM_SIGNING_SECRET` | aanbevolen | (lange random string) | HMAC-secret voor form-tokens |

> **Zonder `TURNSTILE_SECRET`** werkt het formulier nog, maar zonder die laag.
> **Zonder `FORM_SIGNING_SECRET`** gebruikt de server een random secret dat bij elke
> deploy verandert (formulieren die op een oude versie zijn geladen werken dan niet meer).

Genereer een goede `FORM_SIGNING_SECRET` op je eigen computer:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Of via een willekeurige password generator (minimaal 32 tekens).

---

## 🛡️ Spam-bescherming (6 lagen + Turnstile)

Het formulier heeft de volgende verdediging, allemaal onzichtbaar voor echte bezoekers:

1. **Minimale invultijd** — submits binnen 2 seconden = bot
2. **Honeypot-velden** (4 stuks) — verborgen velden die bots vullen, mensen nooit
3. **Ondertekend form-token** — HMAC-gesigneerd timestamp, voorkomt replay-aanvallen
4. **Content-spamfilter** — detecteert spam-trefwoorden, URLs in tekst, hoofdletters-spam, niet-Latijns schrift
5. **Gelaagde rate limiting** — 5 per 10min, 10 per uur, 20 per dag per IP
6. **Stille blokkering** — bots krijgen altijd "ok" terug zodat ze niet leren wat werkt
7. **Cloudflare Turnstile** — CAPTCHA-vervanger, vrijwel altijd onzichtbaar voor mensen

Spam-pogingen zie je in de Railway Deploy Logs (regels die beginnen met `[spam]`).

---

## 🚀 Setup stap-voor-stap

### 1. Resend
- [resend.com/api-keys](https://resend.com/api-keys) → nieuwe key aanmaken
- Zet als `RESEND_API_KEY` in Railway → **Variables**
- Optioneel: domein verifiëren op [resend.com/domains](https://resend.com/domains), dan kun je `MAIL_FROM=offerte@mijnwarmevloer.nl` instellen

### 2. Cloudflare Turnstile (gratis, ~2 min werk)
1. Ga naar [dash.cloudflare.com](https://dash.cloudflare.com) — gratis account aanmaken als je er nog geen hebt
2. In het menu links: klik **Turnstile**
3. Klik **Add Site**
4. Vul in:
   - **Site name**: `mijnwarmevloer.nl`
   - **Domain**: voeg toe `mijnwarmevloer.nl`, `www.mijnwarmevloer.nl`, en (voor nu ook) `mijnwarmevloer-production.up.railway.app`
   - **Widget Mode**: kies **Managed** (Cloudflare bepaalt zelf of een challenge nodig is)
5. Klik **Create** — je krijgt twee waardes:
   - **Site Key** (begint met `0x4AAA...`)
   - **Secret Key** (begint met `0x4AAA...`, andere waarde)
6. Open `contact.html` op GitHub → klik potloodje → zoek `YOUR_TURNSTILE_SITEKEY` en vervang door je **Site Key** → Commit
7. In Railway → **Variables** → nieuwe variable `TURNSTILE_SECRET` met je **Secret Key**
8. Railway redeployt automatisch

### 3. Form signing secret
1. Genereer een random string (zie hierboven, of gebruik een password manager)
2. In Railway → **Variables** → `FORM_SIGNING_SECRET` = die string

### 4. Testen
- Open je site → ga naar Contact → vul formulier in en verstuur
- Je zou onderaan kort een Turnstile-widget moeten zien (vaak alleen een vinkje, geen challenge)
- Check inbox van `MAIL_TO`
- In Railway → Deploy Logs zie je `[spam] ...` regels voor afgewezen pogingen

---

## 🏷️ Versionering

Elke deploy heeft een versienummer. Zo weet je zeker of Railway je nieuwe versie draait.

**Waar je het versienummer ziet:**
- **Footer van elke pagina** — rechts naast de copyright, klein: `· v1.1.0`
- **HTML-broncode** — bovenaan: `<!-- mijnwarmevloer.nl — versie X.Y.Z — build ... -->` (rechtermuisknop → "Paginabron")
- **URL `/version`** — bezoek `mijnwarmevloer-production.up.railway.app/version` → JSON met versie + build-tijd
- **HTTP-header `X-App-Version`** — zichtbaar in DevTools → Network → response headers
- **Railway logs** — bij server-start: `🏷️  mijnwarmevloer.nl versie X.Y.Z — build ...`

**Versie verhogen bij elke wijziging:**
1. Open `package.json`
2. Verander `"version": "1.1.0"` naar bv. `"version": "1.1.1"` (patch: kleine fix) of `"1.2.0"` (minor: nieuwe feature) of `"2.0.0"` (major: grote wijziging)
3. Commit → Railway redeployt → nieuwe versie zichtbaar in de footer

**Semantic versioning (aanbevolen):**
- `MAJOR.MINOR.PATCH` (bv. `1.2.3`)
- `PATCH` (+1) — bug fix, kleine tekstwijziging
- `MINOR` (+1) — nieuwe feature, extra pagina
- `MAJOR` (+1) — nieuw ontwerp, grote restructurering

---


```bash
npm install
RESEND_API_KEY=re_xxxx MAIL_TO=jij@voorbeeld.nl npm start
```
Open http://localhost:8080. Turnstile-laag staat uit als je `TURNSTILE_SECRET` niet meegeeft.

---

## 🏢 Zakelijk
mijnwarmevloer.nl — handelsnaam van **Creditline BV**
Torenlaan 5A, 1402 AT Bussum · KvK 59683198 · BTW NL853603108B01
Daniel de Graaf · 06-46150160 · hallo@mijnwarmevloer.nl
