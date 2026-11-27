# KaamSaathi voice-first upgrade report

## Result

Implemented and tested the personalised, voice-first business and customer-conversation workflows. Existing business data was preserved. The frontend and backend remain runnable locally at http://localhost:3000 and http://localhost:8000.

The largest improvement is fewer control actions, not a proven increase in translation accuracy or model speed. Actual shop-floor usability has not been measured.

## Before and after

| Area | Before | Now |
|---|---|---|
| Shopkeeper language | A top-bar preference already persisted, but no first-time guidance | One-time setup after sign-in; database-backed preference restored after logout/login |
| Customer language | Select a language before translation | Detect the first customer utterance; remember it for that conversation; retain correction controls |
| Recording a translated turn | Start recording, stop recording, then select Translate | Optional one-click conversation session detects sentence endings and submits turns automatically |
| Continuing the conversation | Start each recording manually | Wait for translated playback to finish, then listen for the next turn |
| Selecting business features | Navigate to the assistant or the relevant business page | A shared assistant accepts requests and opens validated internal destinations automatically |
| Sign-up/sign-in identifier | Email only | Email or Indian mobile number; optional private on-device dictation |
| Password entry | Typed password | Typed/autofilled password; dictation stops before password entry |
| Detection/playback failures | Mainly manual recovery | Explicit stop reasons, manual fallbacks, supported-language/confidence checks |

### How much less interaction?

For four spoken translation turns, the old manual flow needed **12 recording/translation button actions**: Start, Stop, Translate for each turn. The new uninterrupted session needs **Start conversation + Stop conversation: 2 actions**, an **83% reduction in these specific controls**.

This is a workflow count, not a human usability benchmark. It excludes entering translation mode, microphone permission, language onboarding, optional transcript review, corrections, playback recovery and starting a new customer conversation. Financial confirmation is intentionally not removed.

Automatic feature selection also removes the need to choose an Inventory, Reports or Translator menu item after stating the request. The app still needs an initial user gesture to enable a voice session.

## Implemented experience

### Shopkeeper

1. Sign up or sign in using email or an Indian mobile number and password.
2. Choose the shop's language once and select **Save language**.
3. Open the shared voice companion and select **Start conversation**.
4. Say "Open inventory", "Show today's earnings", or "Help me translate a conversation with a customer".
5. View the relevant screen while the voice controls remain available for business operations.
6. Confirm or cancel financial changes explicitly. A request to prepare a transaction does not commit it.

### Customer conversation

1. Enter **Translator**. The shopkeeper language is already set.
2. Ask the customer to speak first; **Auto detect** establishes their language.
3. In continuous mode, turns alternate customer/shopkeeper after actual speech playback ends.
4. Shopkeeper replies automatically target the remembered customer language.
5. Use **Stop conversation** to pause or choose a speaker manually. Use **New conversation** for a different customer.

Language is not identity. Two people speaking the same language cannot be reliably distinguished using language detection alone. The interface therefore shows the active turn and retains manual controls rather than claiming automatic speaker recognition.

## Live measurements

One local run used clear, Sarvam-synthesised input speech and the real Saaras, Sarvam Translate and Bulbul APIs. API durations include network round trips; results are individual samples, not averages or service guarantees.

| Operation | Measured seconds |
|---|---:|
| Native assistant routing to Inventory | 2.23 |
| Native assistant routing to Translator | 1.87 |
| Database-backed summary and routing to Reports | 2.71 |
| English speech -> automatic detection -> Tamil translation -> generated audio | 4.73 |
| Hindi speech -> automatic detection -> English translation -> generated audio | 4.48 |
| Tamil speech -> automatic detection -> Hindi translation -> generated audio | 4.77 |

The speech pipeline timings exclude the time spent speaking, input-audio synthesis and output playback. Initial detection returned the expected language in all three synthetic samples. This does **not** establish accuracy for noisy shops, real accents, code-switching or very short replies. There is no comparable old-version latency measurement, so no speedup is claimed.

## Verification

- Backend regression suite: **53 tests passed**, covering new and existing business behaviour.
- **8 shared voice-helper tests passed**, including destination validation, spoken-digit normalisation, language confidence, speaker alternation, natural playback ending, pause/error handling, cancellation, readable validation errors and cross-mode speech isolation.
- Production frontend build and TypeScript check passed.
- Real browser mobile-number sign-up, first-time language setup, actual logout/login and preference restoration passed.
- Real browser microphone capture with synthesised audio passed through the live provider pipeline.
- Business continuous mode automatically submitted speech, opened Inventory, completed playback and started the next capture without another click.
- Microphone instrumentation confirmed no active capture during spoken playback and released tracks after Stop.
- Switching to Translator suppresses and clears business-assistant speech, including late audio responses, so it cannot play over customer capture.
- A prepared financial change remained uncommitted and was cancelled from the shared companion after automatic navigation.
- Translator detected Tamil without a language selection, translated into saved Hindi, played speech and started the next shopkeeper turn.
- A shopkeeper reply targeted remembered Tamil and preserved the protected product name and amount.
- Reset cleared customer language/history; financial-sounding customer text never called the business assistant.
- Automatic same-language detection and subsequent replies in both directions passed without redundant translation requests.
- 390-pixel mobile layouts were checked for horizontal overflow.
- New and legacy database upgrades passed, including running migrations twice.
- Original products, sales, sale items, customer/supplier ledgers, purchases, purchase items, expenses and inventory movements matched the pre-upgrade backup exactly after testing.

Tests used clearly labelled, isolated QA accounts. Existing demo business records and an older pending demo supplier-payment action were not committed, cancelled or reset. That older pending action must be resolved by the shopkeeper before another business-assistant operation.

## Voice login: what works and what does not

### Implemented

- Email or Indian mobile-number registration/login with the existing shop-scoped password/JWT authentication.
- Optional **Speak this field on device** for an identifier or shop name.
- On-device recognition is required; there is no silent fallback to a remote recognition service.
- Where supported, the browser can install an on-device language pack.
- An unavailable or stalled support check gives an explicit typing fallback.
- Password focus and form submission stop identifier dictation.
- Passwords are never sent to STT, translation or the LLM.

### Honest limitations

**Fully voice-only authentication is not implemented.** A spoken password can be overheard and misrecognised; voice alone is not proof of account ownership.

The tested Chromium exposed the local-recognition API, but reported its on-device language packs unavailable. The real unsupported-browser fallback was verified. Successful dictation integration was tested with a **simulated local browser API**: it populated spoken digits, required local processing, aborted on password focus, made no cloud/backend speech requests, and handled a stalled availability check. Actual on-device recognition accuracy remains unverified on this machine.

Mobile numbers are identifiers, not verified phone ownership. No SMS OTP, passkeys, account recovery provider or voice biometrics were added. The recommended next authentication improvement is passkeys/device authentication, or verified phone OTP after choosing and configuring a provider; not spoken passwords.

## Safety and remaining boundaries

- Translation mode cannot invoke business tools. Returning to the shop assistant requires an explicit action.
- Navigation accepts only known internal destinations; model output cannot select arbitrary URLs.
- All financial writes retain server-side validation, confirmation and existing idempotency protections.
- First-language detection below the configured acceptance threshold asks for a retry or manual selection; supported-language checks never silently choose another language.
- Translation is still AI-generated and requires review for important details.
- Continuous mode uses local voice-activity detection and the existing REST APIs, not a new streaming backend. It is an opt-in foreground session, not an always-listening background assistant.
- Background chatter, overlapping speakers and short utterances can cause retries or turn-ending mistakes. A noisy-shop, real-device pilot is still needed.
- Saved language applies to assistant speech and translator defaults; full interface localisation is not complete.
- Live Sarvam features require an API key in the backend process/environment, credits and network access. A process-only key must be configured again after restarting outside the current session.

## Reproduce the checks

From the project directory:

```powershell
python -m pytest -q
node --experimental-strip-types --test src\app\voice-helpers.test.mjs
npm run build
npm run typecheck
```

The helper-test command was verified with Node 22.19.0. See the [README](README.md) for migrations, configuration and manual voice/translation walkthroughs.

## Research references

- [Saaras REST language detection and confidence](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe)
- [Sarvam text language identification](https://docs.sarvam.ai/api-reference/text/identify-language)
- [Sarvam translation](https://docs.sarvam.ai/api-reference/text/translate-text)
- [Browser on-device speech recognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally)
- [Browser microphone permissions](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [Browser audio autoplay restrictions](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
