# KaamSaathi

**Your shop. Your language. Just speak.**

See the [voice-first upgrade report](VOICE_FIRST_REPORT.md) for before/after workflow counts, live timings, verification and authentication limitations.

KaamSaathi is a mobile-first business companion for neighbourhood grocery shops. It combines a FastAPI business API, a Next.js web app, persistent relational records, and an optional server-side Sarvam voice and language-model integration.

## What works in this MVP

- Demo sign-in and email-or-Indian-mobile registration; signed, shop-scoped API sessions.
- Persistent demo shop, catalogue, customer/supplier ledgers, expenses, inventory, and sales.
- Product and stock management; itemised cash, UPI, and credit sales; stock deduction and movement history.
- Customer and supplier balances calculated from ledger entries; payments, purchases, and expenses.
- Confirmation before a sale, purchase, payment, or expense can be committed; cancellation and idempotency protection.
- Daily/weekly summaries, itemised gross-profit estimates, low-stock and transparent reorder suggestions.
- Mobile-friendly dashboard, product catalogue, sales, customer, supplier, expenses, reports, and voice-assistant screens.
- Optional Saaras v4 transcription, Sarvam 105B tool calling, and Bulbul v4 Flash speech generation. No simulated transcription or financial results.
- One-time shop language setup, remembered across sign-ins; automatic customer language detection with optional correction.
- Shared voice controls and validated intent-driven navigation, with opt-in continuous conversation and a manual fallback.
- Two-way customer/shopkeeper translation in Hindi, English, or Tamil, editable transcripts, text input, and translated speech playback.
- In-app customer shopping with shop-name search, the real catalogue, voice/text carts, explicit checkout, accessible preferences and customer order tracking. No QR code, customer account or separate page is required.
- Integrated Customer orders dashboard with acceptance, substitutions requiring customer consent, written/spoken communication and collection fulfilment.

Demo rows are created only for the `demo@kaamsaathi.in` shop in development mode. New registered shops start with their own empty business data.

## Architecture

```text
Next.js / TypeScript (port 3000)
  └── authenticated business requests + scoped public shopping requests
      └── FastAPI / Pydantic (port 8000)
          ├── SQLAlchemy relational models and Alembic migrations
          ├── shop-scoped product, sales, ledger, purchase, expense, and report services
          └── Sarvam HTTP service (backend key only; optional)
```

SQLite is the zero-configuration local demo database. Set `DATABASE_URL` to a PostgreSQL connection string to use PostgreSQL/Supabase Postgres. The API owns all prices, totals, ledger balances, inventory changes, and reporting calculations. The model can only select predefined, schema-validated business tools; it cannot execute SQL.

## Set up on a new laptop

### Prerequisites

- Git, Node.js 22.19 or later in the Node 22 series (includes npm), and Python 3.11 with `pip` and virtual environment support. These versions have been used for local development; Next.js requires at least Node 20.9, while a development dependency requires Node 22.12 or later.
- Internet access to install dependencies. A modern browser is needed to use the app.
- No PostgreSQL, Supabase account, or Sarvam API key is required for the basic local demo. Voice, translation, and AI features require a Sarvam key and model access.

Check `git --version`, `node --version`, `npm --version`, and `python --version` (on Windows, `py --version` also works).

### 1. Clone the project

```powershell
git clone https://github.com/sumansauravsu6/KaamSathi-.git
cd KaamSathi-
```

The commands below assume Windows PowerShell. Keep one terminal running for the backend and use a second terminal for the frontend.

### 2. Set up and start the backend

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Copy the printed value into `JWT_SECRET_KEY` in `backend\.env`, replacing the placeholder. Keep it private; changing it invalidates existing login tokens. Optionally add `SARVAM_API_KEY` there for voice and AI features (see [Sarvam configuration](#sarvam-configuration)). Leave `APP_ENV=development` and the default SQLite URL for the local demo. Do not copy the repository-root `.env.example` over the backend configuration.

Then, still in the activated backend terminal:

```powershell
python -m alembic upgrade head
python -m uvicorn app.main:app --reload --port 8000
```

The migrations create `backend\kaamsaathi.db`; startup also creates any missing schema and seeds the demo shop in development mode. Check <http://localhost:8000/health> and the interactive API reference at <http://localhost:8000/docs>.

When upgrading an existing installation, back up the database, stop the API, run `python -m alembic upgrade head` from `backend`, then restart it. The voice-preference migration preserves existing users and business records, adds an optional mobile identifier, and prompts each shop once to confirm its preferred language. Migration `0003_accessible_shopping` adds shopping sessions, carts/orders, items, messages, events and assistant turns without resetting existing records.

Demo login: `demo@kaamsaathi.in` / `demo1234`, or select **Explore demo shop** in the UI.

### 3. Set up and start the frontend

In another PowerShell window, change to the cloned project root (not `backend`):

```powershell
cd path\to\KaamSathi-
Copy-Item .env.local.example .env.local
npm ci
npm run dev
```

Open <http://localhost:3000>, select **Explore demo shop**, and leave both terminals running. Allow microphone access for recording. Browsers require localhost or HTTPS for microphone access. Stop each server with `Ctrl+C`; on later runs activate the backend virtual environment and repeat the two server commands. Your local SQLite data persists between runs and is not included in the repository.

Leave `NEXT_PUBLIC_API_URL` empty in `.env.local` to use the frontend's same-origin `/api` proxy. `BACKEND_API_URL` is the frontend server's proxy destination (default `http://127.0.0.1:8000`); it is not a browser credential. Configure `PUBLIC_SHOP_BASE_URL` in `backend/.env` to the frontend's public origin so generated QR codes open the correct site. Restart the backend after changing that setting; rebuild/restart the production frontend after changing its proxy destination.

### macOS / Linux

After cloning and entering the project directory, use the same prerequisites and configuration above. In the first terminal:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Paste the printed secret into `backend/.env`, optionally configure Sarvam, then run:

```bash
python -m alembic upgrade head
python -m uvicorn app.main:app --reload --port 8000
```

In a second terminal at the project root:

```bash
cp .env.local.example .env.local
npm ci
npm run dev
```

Open <http://localhost:3000>. On Linux, install your distribution's Python `venv` package if virtual environment creation fails.

### Troubleshooting

- If PowerShell blocks activation, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` in that terminal and activate again, or call `.\.venv\Scripts\python.exe` directly instead of `python`.
- If the app cannot reach the API, confirm both servers are running and check <http://localhost:8000/health>. Make sure ports 3000 and 8000 are available and `BACKEND_API_URL` points to the backend.
- If voice or translation reports a configuration error, set a valid `SARVAM_API_KEY` in `backend/.env`, check account credits/model access, and restart the backend. Ordinary forms work without the key.
- Never commit `.env`, `.env.local`, database files, API keys, or the JWT secret. Use the example files as templates only.

### PostgreSQL / Supabase (optional)

For PostgreSQL, set `DATABASE_URL` in `backend/.env`, for example:

```text
postgresql+psycopg://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
```

The PostgreSQL driver is included in `requirements.txt`. Run migrations from `backend`:

```powershell
alembic upgrade head
```

The migration creates the schema only; it does not seed a demo account in non-development environments. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are included for Supabase project configuration, but this MVP currently uses its own password authentication and JWTs. Do not treat the Supabase variables as an active auth integration.

## Sarvam configuration

Get an API key from the Sarvam AI developer console and put it **only** in `backend/.env`:

```dotenv
SARVAM_API_KEY=your-key
SARVAM_STT_MODEL=saaras:v4
SARVAM_STT_MODE=transcribe
SARVAM_TTS_MODEL=bulbul:v4-flash
SARVAM_LLM_MODEL=sarvam-105b
SARVAM_TRANSLATE_MODEL=sarvam-translate:v1
SARVAM_API_BASE_URL=https://api.sarvam.ai
SARVAM_TTS_SPEAKERS={"hi-IN":"ritu_hi_conversation","en-IN":"roopa_en_conversational","ta-IN":"gokul_ta_narration"}
SARVAM_KEYTERMS=Maggi,milk,bread,rice,sugar,atta,sunflower oil,biscuits,soap,shampoo,toothpaste
```

The backend sends recorded audio to `POST /speech-to-text` (multipart; `transcribe` or `codemix`), assistant requests to `/v2/chat/completions`, and speech requests to `/text-to-speech`. Speech recordings are capped at 30 seconds in the browser and 12 MB on the server. TTS output is capped to 1,200 characters. STT uses a JSON-encoded `keyterms` list combining the current shop's pending supplier name, saved suppliers/customers/products and configured terms (up to 50 distinct terms of at most 64 characters, as required by Saaras v4; longer names are omitted from this recognition hint only). Business speech uses the saved shop language as a hint and `transcribe` mode; translation still auto-detects the customer language. Optional STT `language` accepts `hi-IN`, `en-IN` or `ta-IN`; omit it for auto-detection and available confidence. Recognition hints improve context but cannot guarantee an unfamiliar name. Assistant requests use validated, shop-scoped functions; write tools create a pending action and cannot commit until confirmed.

Browser audio MIME codec parameters are removed before forwarding uploads to Sarvam, which requires the base media type (for example, `audio/webm` rather than `audio/webm;codecs=opus`).

With no API key, the dashboard, records and conventional forms still work. Voice, translation, and LLM requests return actionable setup errors; speech is never faked. Live STT, TTS, assistant tools, and translation have been smoke-tested locally; your account still needs credits and access to the configured models.

Never put a Sarvam key in a `NEXT_PUBLIC_*` variable or commit `.env` files.

## Customer conversation translator

The shopkeeper's language comes from the saved shop preference. The customer starts in **Auto detect**; ask the customer to speak first so the app knows which language to use for replies.

1. Select **Speak as shopkeeper** or **Speak as customer** and stop when finished (30-second maximum).
2. Review or edit the transcript in that person's message box, or type a message instead.
3. Select **Translate for customer** or **Translate for shopkeeper**. Original and translated text appear together.
4. Use the audio controls or **Play translation** to hear the result. If speech fails, the translated text remains available.

Alternatively, choose **Start conversation** for automatic turn capture and submission. The session alternates customer/shopkeeper turns; language detection is not speaker identification. Stop the session before handing the device to a different customer and choose **New conversation** to reset the detected language and history. Manual microphone, text entry, and language correction remain available. Unclear first-language detection asks for a longer sentence or a manual choice rather than guessing. When both people use the same language, automatic mode can pass their text through without an unnecessary translation request.

The translator calls Sarvam's dedicated `/translate` API, not the business assistant. It cannot create sales, payments, stock changes, or pending actions, even when spoken text sounds like a business command. Every call requires authentication. The glossary uses only the signed-in shop's product, customer, and supplier names. Numbers and known names are masked and checked before translated output is accepted. Add other names or addresses in the optional comma-separated field (up to 20 terms). If the provider changes or drops protected information, the request fails explicitly; rephrase and retry rather than trusting an altered amount.

Both people should review important details: AI translation can still make grammatical or semantic mistakes. Translation history is limited to 20 turns in page memory, is cleared on navigation/reload, and is not stored in the database. Text/audio are sent to Sarvam for processing. `SARVAM_TRANSLATE_MODEL` defaults to `sarvam-translate:v1`; `mayura:v1` can also be configured, using formal mode.

## Personalised voice-first operation

After first sign-in, choose a preferred language and select **Save language**. The choice belongs to the authenticated shop and is restored on the next sign-in, including on another browser. The top-bar selector can change it later. Assistant speech and translator defaults use this preference; the entire interface is not yet localised.

Use the shared voice companion from business pages. Requests such as "Open inventory", "Show today's earnings", or "Help me talk to a customer" select the appropriate feature through a schema-validated `navigate_app` tool or a successful business-query tool. Only known internal screens are accepted. The voice controls remain available while viewing business results. Payments, sales, purchases, expenses, and voice-created suppliers require explicit confirmation; navigating never commits a financial change. An existing pending change must be confirmed or cancelled before another write; read-only queries and navigation remain available without committing or replacing it.

Intent routing uses Sarvam's native tool calling, not a separate keyword classifier. "Show my customer list" uses `list_customers`, including zero-balance customers (at most 50 names per answer, with the full count; the Customers screen shows the list). "Add a new supplier" uses `start_workflow` to open the existing supplier form and ask for the name; dictate the name in the next turn or provide it initially. `create_supplier` prepares a shop-scoped, duplicate-checked action and saves only after confirmation. "A supplier for biscuits" describes goods, so the assistant asks for the company name rather than assuming it is "Biscuits"; an explicit company named Biscuit remains valid. Say "No, the supplier's name is Anmol Tea" to correct an unconfirmed supplier directly through `update_pending_supplier`, keeping the optional phone and asking for confirmation again. Say "Cancel that and add Anmol Tea instead" to cancel and prepare a replacement through `cancel_pending_action`; it does not reverse completed business records. Once a valid change is ready, the server immediately presents its confirmation without another unnecessary model round-trip. "Add a transaction" asks whether you mean a sale, supplier purchase, customer payment, supplier payment, or operating expense rather than guessing. Successful tool results supply validated destination/action metadata; prepared writes take precedence over incidental navigation. Short, ambiguous, or noisy utterances can still need clarification.

Tap the main microphone to **Start conversation**. It uses local voice-activity detection with the existing REST endpoints, not a new streaming service. Speak, then pause for three seconds or tap **Send now**. Short thinking pauses no longer cut a sentence after 1.1 seconds. Capture pauses during spoken playback and resumes after the reply, including while clarification or confirmation is needed. Silence does not end the session after eight seconds: silent 30-second recordings are discarded locally and listening resumes without sending empty audio to Sarvam. **Stop conversation** ends capture and releases the microphone. Real recording, network, or playback failures still stop with an explicit reason; transactions are never retried automatically. Browser microphone permission, localhost/HTTPS, network access, and working audio playback are required. No always-on or locked-screen operation is promised.

For unfamiliar names or noisy conditions, choose **Record & review instead**. Tap the microphone to finish, edit the recognised words, then choose **Send to Saathi**. The transcript is not executed before this explicit send. Text input remains available when a hands-free session is stopped. Neither mode guarantees perfect recognition; check the transaction summary and correct it before saying yes.

### Sign-in without dictating secrets

Register with either an email address or a 10-digit Indian mobile number (optional `+91` prefix) and a password. Mobile numbers are login identifiers, **not SMS-verified ownership**; no OTP service is configured. Existing email accounts keep working.

The sign-in and registration forms offer **Speak this field on device** for the identifier and shop name. This requires browser support for `SpeechRecognition.processLocally` and an available on-device language pack. A supported browser may offer to install a pack. If local recognition is unavailable, the UI explicitly falls back to typing/autofill; it never silently uses remote speech recognition. Password focus and form submission stop identifier dictation. Passwords are never sent to STT, translation, or the LLM.

**Voice-only password authentication is not implemented.** Speaking a password in a shop exposes it to other people and makes punctuation/case unreliable. Use a typed/autofilled password for this MVP. Passkeys or verified phone OTP are possible follow-ups, but require a separate authentication implementation and real-device/provider testing; speech is not proof of identity.

## Accessible customer shopping

Open the main app and select **Shop as customer**, find the shop by name and select it. Customer shopping stays at the main app URL (`/`); it does not open another page or tab. Customers need no account, QR code or app installation. Shop search requires at least two characters and returns at most ten matching shops with active products, exposing only shop name, address and ID.

Use **Back to main app** in the sticky top navigation to leave customer shopping. It is also available on shop selection and the legacy shop page. Saved orders remain available on the device; leaving unsaved edits asks for confirmation. After a shared-device handover, returning opens shopkeeper sign-in rather than exposing the dashboard.

On the merchant dashboard, **Start customer shopping** opens the current shop in this same app. The handover requires confirmation, signs out the merchant and removes the previous customer's saved capability for that shop on this shared device. Going back to shopkeeper mode requires signing in again; customers cannot reveal business records by pressing Back. Merchant order management remains separate from customer permissions, even though both modes are in the same application.

The earlier `/shop/{shopId}` route and QR API remain for backward compatibility, but QR/link controls are no longer the entry point shown on the dashboard.

### Customer journey

1. Choose **Text & Braille**, **Voice guidance** or **Visual & touch**. Preferences stay on the browser; no disability disclosure is requested. High contrast, large text, simple steps and one-product browsing can be combined.
2. The in-app journey starts with simple steps and one product at a time. Search, use labelled increase/decrease controls or enter quantities. **Save and review order** saves all selected products and moves directly to the current server-priced review, without requiring a separate save screen.
3. Read the review forwards from its focused heading: item names, quantities, line prices and total are included together. **Confirm and place order** is a separate, explicit action. Adding/changing items requires another review. The model cannot set prices, stock or execute checkout itself.
4. Follow the written order history and messages. Customer and merchant see the same short order reference. **Check order updates** and **Refresh written replies** work on demand without losing keyboard focus; background polling also leaves focus alone. Common phrases include "Please communicate with me in writing" and a request to bring the order to the counter.
5. If the merchant proposes a replacement, review its actual product, quantity, unit, price and revised total. Accept or decline explicitly; no silent substitution is made.

**Text & Braille** disables read-aloud, hides microphone/audio controls and illustrations, collapses extra controls and keeps one main shopping panel visible. Product selection, checkout, written communication and order tracking do not call the LLM, STT or TTS. The saved mode/shop and order recover on reload, with submitted orders opening directly in tracking. A refreshable Braille display is driven by the user's OS/screen reader, not by an invented web Braille translator. A person without usable sight, hearing or speech needs compatible tactile assistive input/output; a web page alone cannot provide tactile access.

Voice remains optional for those who benefit from it: select English, Hindi or Tamil, start a conversation, or use manual 30-second recording with an editable transcript. Spoken "yes" commits only a currently reviewed cart. Read-aloud messages/statuses and common-phrase speech remain available outside Text & Braille mode.

The interface includes labelled controls, semantic headings/logs, standard keyboard/switch-compatible controls, visible focus, a skip link, large touch targets, adjustable text, one-panel simple steps and captions/transcripts for speech. Switch-device and Braille compatibility require real-device validation, not just keyboard automation. Product illustrations outside silent mode are category guides, not actual product photographs.

### Shopkeeper fulfilment and stock

- Orders move through **Draft -> Pending shopkeeper confirmation -> Accepted -> Ready for collection -> Completed**, with constrained rejection/cancellation paths.
- Pending orders do not deduct or reserve inventory. Acceptance revalidates prices/availability and reserves stock. Existing retail sales and stock adjustments respect accepted/ready reservations.
- Completion records exactly one existing KaamSaathi sale, deducts inventory and releases the reservation atomically. Select cash/UPI only for payment **already collected at the shop**; there is no online payment processing.
- The merchant can send written replies, record/edit a transcribed reply, translate messages using their recorded source language, and suggest replacements. Known products and numbers are protected during translation.
- Customer status/messages poll every five seconds; the merchant queue polls every ten seconds. These are in-page updates, not background push notifications. Network/provider failures are shown explicitly; writes are not blindly retried.

### Privacy, PWA and phone demos

Customer access uses a shop-scoped, seven-day bearer capability stored on that browser; only its hash is stored server-side. The token is sent in `X-Shopping-Token`, never embedded in a URL. Treat a shared browser as shared access to that customer's order. Merchant-to-customer handover deliberately starts a fresh session; returning customers on their own devices can resume saved access. Expired/invalid saved access has an explicit recovery action; clearing it loses access to the previous anonymous order. Each shopping session can submit one order.

The existing PWA worker is scoped to the legacy `/shop/` route. It caches static offline help/icons only, never inventory, API responses, tokens or order pages. In-app customer mode does not expand that worker to the merchant app or cache private records. The main-app customer journey requires a live connection; no offline ordering or root-page installation guarantee is made.

For a real phone demo, open the main app on a reachable **HTTPS frontend**. Another device's localhost is not your computer. HTTPS is required for phone microphone/PWA access. Keep the API behind the same-origin proxy rather than exposing credentials or putting a loopback API address in browser configuration. `PUBLIC_SHOP_BASE_URL` is needed only for correctly configured legacy share links/QRs, not for in-app entry.

### Verified accessibility scenarios and limits

Local Chromium verification passed 16 end-to-end checks, with zero axe violations across nine scanned customer/merchant states. This included keyboard-only selection/review/checkout, combined preferences and 320/390/768-pixel reflow, written communication, common-phrase speech, automatic spoken status updates without focus theft, actual QR decoding, offline-help/cache boundaries, invalid-session recovery and unavailable products.

The integrated flow passed ten additional browser checks and five further zero-violation axe states: guest shop selection without navigation, silent one-product browsing, forward-readable review, explicit checkout, persistence, selectable written communication, merchant fulfilment, exactly one recorded sale, focus-preserving updates and safe shared-device handover. The complete customer journey ran with microphone/audio deliberately unavailable and made **zero speech or assistant API calls**. The pre-feature database comparison also verified all 477 pre-existing rows unchanged, using every original column and primary key.

Live provider checks exercised actual browser MediaRecorder/VAD -> Saaras transcription -> Sarvam native tools -> Bulbul speech -> spoken confirmation -> merchant fulfilment. They used controlled microphone audio, not a human or physical microphone. Manual customer recording stopped at 30 seconds and exposed an editable transcript without executing it; merchant speech likewise required explicit Send. Separate live Hindi and Tamil cart/confirmation checks passed, as did browser replacement approval, merchant acceptance, customer cancellation and protected English-to-Tamil message translation.

**This is not WCAG certification and not a claim that every disability is covered.** Real Android TalkBack, iOS VoiceOver, refreshable Braille, physical switch-device and deafblind/disability-user testing remain necessary. Axe leaves checks requiring manual assessment; keyboard/ARIA automation is not equivalent to a screen reader or tactile hardware. Physical collection may still need assistance agreed with the shop through written messages; independent travel/physical handover is outside this app. Full UI localisation, background notifications and offline ordering are not implemented. Production public-provider abuse controls need shared/distributed rate limiting rather than the current per-process limiter.

## Demo walkthrough

1. Open the app and choose **Explore demo shop**.
2. The demo has sample products, a recent demo sale, Ravi (no opening balance), Sita (sample udhaar), Kumar Traders (sample supplier due), and a demo electricity expense.
3. Maggi starts at 20 packets after the clearly identified sample sale; buying price is ₹12 and selling price ₹15.
4. Record 3 Maggi on credit for Ravi. Review the amount and explicitly confirm. Stock becomes 17; Ravi's ledger is charged ₹45.
5. Record a ₹20 payment for Ravi and confirm it. His due becomes ₹25.
6. Ask the assistant “How many Maggi packets are in stock?” and “How much does Ravi owe?” once Sarvam is configured; the same values are visible in Inventory and Customers.
7. Dashboard/report figures come from the stored transactions. The demo includes historical rows, so its all-time and weekly totals will also include demo activity.

## API outline

Authentication: `POST /api/auth/register`, `POST /api/auth/login`, development-only `POST /api/auth/demo`.

Registration accepts `{ "email": "...", "password": "...", "shop_name": "..." }` or `{ "phone": "+919876543210", "password": "...", "shop_name": "..." }` (exactly one identifier). Login accepts `{ "identifier": "email or mobile", "password": "..." }`; the original `{ "email": "...", "password": "..." }` shape remains supported. `GET /api/shop` includes `language_configured`; saving a supported `language` with `PATCH /api/shop` sets this flag. Assistant responses may include a whitelisted `destination`.

All business endpoints require `Authorization: Bearer <access_token>`.

| Area | Routes |
|---|---|
| Shop | `GET/PATCH /api/shop` |
| Products | `GET/POST /api/products`, `PATCH/DELETE /api/products/{id}`, `GET /api/products/low-stock` |
| Sales | `GET/POST /api/sales` (POST creates a pending confirmation) |
| Customers | `GET/POST /api/customers`, `GET /api/customers/{id}/ledger`, `POST /api/customers/{id}/payments` |
| Suppliers | `GET/POST /api/suppliers`, `POST /api/suppliers/{id}/payments`, `POST /api/purchases` |
| Expenses | `GET/POST /api/expenses` |
| Reports | `GET /api/dashboard/summary`, `GET /api/reports/daily`, `GET /api/reports/weekly`, `GET /api/reports/reorder-suggestions` |
| Voice | `POST /api/voice/transcribe`, `POST /api/voice/speak`, `POST /api/assistant/respond` |
| Translation | `POST /api/translation` with `{ "text": "...", "source_language": "auto", "target_language": "ta-IN", "protected_terms": ["optional name"] }`. Audio may supply `detected_language` and `language_probability`; otherwise `/text-lid` detects the text language. Maximum 1,000 characters. Explicit equal languages are rejected; auto-detected equal languages return `same_language: true`. |
| Confirmation | `POST /api/assistant/confirm` with `{ "action_id": "...", "confirmed": true|false }` |
| Customer orders | Authenticated `GET /api/shopping/link`, `GET /api/shopping/orders`, per-order status, messages and substitution routes |
| Public shopping | `GET /api/public/shops?q=shop-name` (2-100 characters, max 10 results), `GET /api/public/shops/{shopId}`, `/qr.svg`, `POST /sessions`; capability-scoped cart, review, checkout, order tracking/cancellation, messages, substitutions, assistant, speech and translation routes |

`POST /api/assistant/cancel` is also available for pending assistant actions. A confirmed action is one-shot; repeated confirmations are rejected. Transaction routes accept idempotency keys, use server-side validation, and scope lookups to the authenticated shop.

## Tests

```powershell
cd backend
python -m pytest -q
cd ..
node --experimental-strip-types --test src\app\voice-helpers.test.mjs
npm run build
npm run typecheck
```

Verified regression results: **111 backend tests and 11 frontend helper tests passed**, alongside a production build and TypeScript check. Shopping tests cover bounded/literal public shop search, server-owned prices/totals, stale reviews/revisions, explicit consent, capability/shop isolation, reservation-safe stock edits/sales, concurrent acceptance, exactly-once completion, substitutions, native tool validation/replay handling and provider errors. Browser/live checks are described above; automated backend tests do not spend provider credits.

The helper tests use Node's built-in runner (verified with Node 22.19.0). The backend tests use isolated SQLite databases and mocked Sarvam responses. Tests cover mobile identifiers, preference persistence/isolation, repeatable database upgrades, native navigation, validation, protected information, provider errors, authenticated access, shop-scoped glossaries, supplier corrections/cancellation/replacement before confirmation, speech hint limits, thinking pauses, and separation from business execution. To repeat live smoke tests, configure a development API key, sign in, and use the voice assistant and Translator. Try "Add a supplier named Biscuit Wholesale", pause before replying, correct it with "No, the name is Anmol Tea", then confirm and verify only Anmol Tea was created. Also try Record & review, edit the recognised name, and verify nothing is prepared until Send. For translation, try an English-to-Hindi or English-to-Tamil message such as "3 Maggi packets cost INR 45", then reply from the customer's side and verify names and numbers in both directions.

## Current MVP boundaries

- Local email-or-mobile/password/JWT authentication is implemented. Supabase Auth, phone verification, OTP, passkeys, and spoken-password authentication are not wired in this MVP.
- Local development defaults to SQLite. PostgreSQL is supported by SQLAlchemy; a PostgreSQL driver must be installed for that deployment.
- Sarvam integration is implemented but requires a valid API key, available account credits, and supported model access to verify live.
- Demo sample data is not copied into a newly registered shop.
