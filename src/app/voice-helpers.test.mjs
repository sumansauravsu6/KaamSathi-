import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assistantSpeech, businessAudioAllowed, errorDetailMessage, customerDetection, nextSpeaker, playbackStopReason, waitForPlayback, normalizeSpokenIdentifier, pageDestination, supportedLanguage, voiceTurnReady, workflowAction } from "./voice-helpers.ts";

test("only exact known destinations are accepted", () => {
  assert.equal(pageDestination("Translator"), "Translator");
  assert.equal(pageDestination("Inventory"), "Inventory");
  assert.equal(pageDestination("inventory"), null);
  assert.equal(pageDestination("/api/shop"), null);
  assert.equal(pageDestination(null), null);
});

test("workflow actions only open the matching known form", () => {
  assert.equal(workflowAction(pageDestination("Suppliers"), "add_supplier"), "add_supplier");
  assert.equal(workflowAction(pageDestination("Customers"), "add_supplier"), null);
  assert.equal(workflowAction(pageDestination("Suppliers"), "delete_supplier"), null);
  assert.equal(workflowAction(null, "add_supplier"), null);
});

test("an unrelated read speaks its answer rather than an old pending transaction", () => {
  const pending = { summary: "Record an expense for 50 rupees." };
  assert.equal(assistantSpeech("Ravi and Sita are your customers.", pending, false), "Ravi and Sita are your customers.");
  assert.equal(assistantSpeech("Say yes to save or tell me what to correct.", pending, true), `${pending.summary} Say yes to save or tell me what to correct.`);
  assert.equal(assistantSpeech("Payment recorded.", null, false), "Payment recorded.");
});

test("thinking time and pauses inside a sentence do not finish a turn", () => {
  assert.equal(voiceTurnReady(9000, null), false);
  assert.equal(voiceTurnReady(29000, null), false);
  assert.equal(voiceTurnReady(5000, 1800), false);
  assert.equal(voiceTurnReady(6000, 2900), false);
  assert.equal(voiceTurnReady(6100, 3000), true);
  assert.equal(voiceTurnReady(30000, 50), true);
  assert.equal(voiceTurnReady(30000, null), true);
});

test("spoken phone digits normalize without guessing email or ambiguous phrases", () => {
  assert.equal(normalizeSpokenIdentifier("nine eight seven six five four three two one zero"), "9876543210");
  assert.equal(normalizeSpokenIdentifier("plus nine one nine eight seven six five four three two one zero"), "+919876543210");
  assert.equal(normalizeSpokenIdentifier("double nine 87654 321"), "9987654321");
  assert.equal(normalizeSpokenIdentifier("+91 98765 43210"), "+919876543210");
  assert.equal(normalizeSpokenIdentifier("nine@example.com"), "nine@example.com");
  assert.equal(normalizeSpokenIdentifier("ninety one"), "ninety one");
  assert.equal(normalizeSpokenIdentifier("one two"), "one two");
});

test("first customer speech requires a supported confident language", () => {
  assert.deepEqual(customerDetection("ta", 0.65), { language: "ta-IN", probability: 0.65 });
  assert.equal(customerDetection("hi-IN", 0.649), null);
  assert.equal(customerDetection("en", null), null);
  assert.equal(customerDetection("fr", 0.99), null);
  assert.equal(customerDetection("en", NaN), null);
  assert.equal(customerDetection("en", 1.1), null);
  assert.equal(supportedLanguage("HI_in"), "hi-IN");
});

test("conversation alternates speakers regardless of language", () => {
  assert.equal(nextSpeaker("customer"), "shopkeeper");
  assert.equal(nextSpeaker("shopkeeper"), "customer");
  assert.equal(nextSpeaker(nextSpeaker("customer")), "customer");
});

class FakeMedia extends EventTarget {
  ended = false;
  playResult = Promise.resolve();
  play() { return this.playResult; }
  pause() { this.dispatchEvent(new Event("pause")); }
  finish() { this.ended = true; this.dispatchEvent(new Event("pause")); this.dispatchEvent(new Event("ended")); }
}

test("natural playback end (pause then ended) continues the session", async () => {
  const media = new FakeMedia();
  const result = waitForPlayback(media);
  media.finish();
  assert.deepEqual(await result, { ok: true });
});

test("user pause, blocked autoplay and abort stop with explicit reasons", async () => {
  const paused = new FakeMedia();
  const pausedResult = waitForPlayback(paused);
  paused.pause();
  assert.deepEqual(await pausedResult, { ok: false, reason: "paused" });

  const blocked = new FakeMedia();
  blocked.playResult = Promise.reject(new Error("NotAllowedError"));
  const blockedResult = await waitForPlayback(blocked);
  assert.deepEqual(blockedResult, { ok: false, reason: "blocked" });
  assert.match(playbackStopReason(blockedResult), /blocked/);

  const controller = new AbortController();
  const aborted = waitForPlayback(new FakeMedia(), controller.signal);
  controller.abort();
  assert.deepEqual(await aborted, { ok: false, reason: "aborted" });
  assert.equal(playbackStopReason({ ok: false, reason: "aborted" }), "");
});

test("errorDetailMessage formats validation arrays and keeps plain errors", () => {
  const fallback = "Something went wrong (422). Please try again.";
  assert.equal(errorDetailMessage("Invalid email or password", fallback), "Invalid email or password");
  assert.equal(errorDetailMessage([{ loc: ["body", "phone"], msg: "Value error, Enter a valid Indian mobile number", type: "value_error" }], fallback), "phone: Value error, Enter a valid Indian mobile number");
  assert.equal(errorDetailMessage([{ loc: ["body"], msg: "Provide exactly one" }, { bad: true }, 4], fallback), "Provide exactly one");
  assert.equal(errorDetailMessage({ detail: "x" }, fallback), fallback);
  assert.equal(errorDetailMessage([], fallback), fallback);
  assert.equal(errorDetailMessage(null, fallback), fallback);
});

test("business speech is blocked once the translator is the active page", () => {
  assert.equal(businessAudioAllowed(pageDestination("Translator")), false);
  assert.equal(businessAudioAllowed(pageDestination("Inventory")), true);
  assert.equal(businessAudioAllowed("Dashboard"), true);
});
