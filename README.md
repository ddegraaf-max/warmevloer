# mijnwarmevloer.nl

Website + offerteformulier voor **mijnwarmevloer.nl** — een handelsnaam van Creditline BV.

Het formulier verstuurt aanvragen via [Resend](https://resend.com) naar je inbox.

---

## 📂 Structuur

Alle bestanden staan plat in de hoofdmap (geen submappen — makkelijker uploaden):

```
.
├── index.html, contact.html, faq.html, projecten.html,
│   privacy.html, voorwaarden.html       ← de website-pagina's
├── style.css, script.js                 ← styling + interactie
├── favicon.svg, favicon.ico, *.svg,     ← afbeeldingen/logo's
│   og-image.jpg, robots.txt, sitemap.xml
├── server.js         ← Node.js-server: serveert de site + verwerkt het formulier
├── package.json      ← dependencies (express, resend)
├── Dockerfile        ← bouwt de container voor Railway
├── .gitignore
└── README.md
```

> De server vindt de website-bestanden automatisch, of ze nu in de hoofdmap staan of in een `public/`-submap.

---

## ⚙️ Environment variables (instellen in Railway)

De server gebruikt 3 omgevingsvariabelen. Stel ze in via Railway → je service → tab **Variables**:

| Variabele | Verplicht | Voorbeeld | Uitleg |
|---|---|---|---|
| `RESEND_API_KEY` | ✅ ja | `re_xxxxxxxx` | Je Resend API-key |
| `MAIL_TO` | nee | `hallo@mijnwarmevloer.nl` | Waar aanvragen heen gaan (default: hallo@mijnwarmevloer.nl) |
| `MAIL_FROM` | nee | `offerte@mijnwarmevloer.nl` | Afzender (default: onboarding@resend.dev) |

> **Belangrijk:** zet de API-key NOOIT in de code of in GitHub. Alleen in Railway's Variables-tab. Daar staat hij veilig en is hij niet zichtbaar voor bezoekers.

---

## 🚀 Stap-voor-stap configuratie

### Stap 1 — Nieuwe API-key in Resend
1. Ga naar [resend.com/api-keys](https://resend.com/api-keys)
2. Verwijder de oude key (als je 'm al ergens hebt gedeeld)
3. Klik **Create API Key**, geef 'm een naam (bv. "Railway productie"), kies **Sending access**
4. Kopieer de key (begint met `re_...`) — je ziet 'm maar één keer

### Stap 2 — Key in Railway zetten
1. Ga naar je Railway-project → klik je service
2. Tab **Variables** → **+ New Variable**
3. Naam: `RESEND_API_KEY`, waarde: plak je key
4. Voeg eventueel `MAIL_TO` en `MAIL_FROM` toe
5. Railway redeployt automatisch

### Stap 3 — Domein verifiëren in Resend (belangrijk!)
Standaard kun je alleen mailen vanaf `onboarding@resend.dev`. Om vanaf `@mijnwarmevloer.nl` te versturen:

1. Ga naar [resend.com/domains](https://resend.com/domains) → **Add Domain**
2. Voer `mijnwarmevloer.nl` in
3. Resend geeft je een aantal **DNS-records** (SPF, DKIM)
4. Zet die records bij je domeinregistrar (waar je `mijnwarmevloer.nl` hebt gekocht)
5. Wacht tot Resend de domein als "Verified" markeert (kan tot een uur duren)
6. Zet daarna `MAIL_FROM` in Railway op bv. `offerte@mijnwarmevloer.nl`

> Tot je domein geverifieerd is: laat `MAIL_FROM` leeg (dan gebruikt 'ie `onboarding@resend.dev`). De mail komt dan nog steeds aan, alleen met een Resend-afzender.

---

## 🧪 Testen
1. Open je site → ga naar Contact
2. Vul het formulier in en verstuur
3. Check de inbox van `MAIL_TO`
4. Lukt het niet? Kijk in Railway → **Deploy Logs** voor foutmeldingen

---

## 💻 Lokaal draaien
```bash
npm install
RESEND_API_KEY=re_xxxx MAIL_TO=jij@voorbeeld.nl npm start
```
Open dan http://localhost:8080

---

## 🏢 Zakelijk
mijnwarmevloer.nl — een handelsnaam van **Creditline BV**
Torenlaan 5A, 1402 AT Bussum · KvK 59683198 · BTW NL853603108B01
Daniel de Graaf · 06-46150160 · hallo@mijnwarmevloer.nl
