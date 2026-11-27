"use client";

import { Languages, Mic, Pause, Send, Volume2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { customerDetection, nextSpeaker, playbackStopReason, supportedLanguage, waitForPlayback, type Speaker } from "./voice-helpers";
import { useVoiceSession } from "./use-voice-session";

type Translation = {
  original_text: string;
  translated_text: string;
  source_language: string;
  target_language: string;
  same_language?: boolean;
};
type Turn = Translation & { id: number; speaker: Speaker };
type Props = {
  token: string;
  preferredLanguage: string;
  apiRequest: <T>(path: string, token: string, options?: RequestInit) => Promise<T>;
  onExit: () => void;
};
const LANGUAGES = [
  { code: "hi-IN", name: "Hindi / हिन्दी" },
  { code: "en-IN", name: "English" },
  { code: "ta-IN", name: "Tamil / தமிழ்" },
];
const languageName = (code: string) => LANGUAGES.find((item) => item.code === code)?.name || code;

export default function Translator({ token, preferredLanguage, apiRequest, onExit }: Props) {
  const [shopLanguage, setShopLanguage] = useState(preferredLanguage);
  const [customerLanguage, setCustomerLanguage] = useState("auto");
  const [detected, setDetected] = useState<{ language: string; probability: number } | null>(null);
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [drafts, setDrafts] = useState<Record<Speaker, string>>({ shopkeeper: "", customer: "" });
  const [protectedTerms, setProtectedTerms] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState("Ready. Choose who is speaking.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState<Speaker | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const operation = useRef(0);
  const lastTurn = useRef<HTMLDivElement>(null);
  const speakerRef = useRef<Speaker>("customer");
  const customerLanguageRef = useRef(customerLanguage);
  customerLanguageRef.current = customerLanguage;
  const [activeSpeaker, setActiveSpeaker] = useState<Speaker>("customer");
  const voiceSession = useVoiceSession((blob, signal) => continuousTurn(blob, signal));

  useEffect(() => {
    lastTurn.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns]);

  useEffect(() => { setShopLanguage(preferredLanguage); }, [preferredLanguage]);

  useEffect(() => () => {
    operation.current += 1;
    controller.current?.abort();
    if (timeout.current) clearTimeout(timeout.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  function begin() {
    audio.current?.pause();
    controller.current?.abort();
    controller.current = new AbortController();
    setError("");
    setBusy(true);
    return ++operation.current;
  }

  function cancel() {
    operation.current += 1;
    controller.current?.abort();
    if (timeout.current) clearTimeout(timeout.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    setListening(null);
    setBusy(false);
    setStatus("Cancelled. No business records were changed.");
  }

  async function play(text: string, language: string, id: number, signal?: AbortSignal, waitForEnd = false): Promise<string | null> {
    const response = await apiRequest<Response>("/api/voice/speak", token, {
      method: "POST", body: JSON.stringify({ text, language }), signal: signal || controller.current?.signal,
    });
    const blob = await response.blob();
    if (operation.current !== id || signal?.aborted) return "";
    const url = URL.createObjectURL(blob);
    flushSync(() => setAudioUrl(url));
    const element = audio.current;
    if (!element) throw new Error("Audio controls are unavailable.");
    if (!waitForEnd) {
      try { await element.play(); return null; }
      catch { throw new Error("Automatic playback was blocked. Use the audio controls."); }
    }
    const playback = await waitForPlayback(element, signal);
    const reason = playbackStopReason(playback);
    if (reason && operation.current === id) setError(reason);
    return playback.ok ? null : reason;
  }

  async function continuousTurn(blob: Blob, signal: AbortSignal): Promise<string | null> {
    const speaker = speakerRef.current;
    const id = ++operation.current;
    setBusy(true);
    setError("");
    setStatus(`Transcribing ${speaker}…`);
    try {
      const data = new FormData();
      data.append("file", blob, blob.type.includes("mp4") ? "conversation.mp4" : "conversation.webm");
      data.append("mode", "transcribe");
      const heard = await apiRequest<{ transcript: string; language_code?: string | null; language_probability?: number | null }>("/api/voice/transcribe", token, {
        method: "POST", body: data, signal,
      });
      if (signal.aborted || operation.current !== id) return "";
      const text = heard.transcript.trim();
      if (!text) throw new Error("No speech was recognised. Retry or type the message.");
      setDrafts((current) => ({ ...current, [speaker]: text }));
      const customer = customerLanguageRef.current;
      let detection: ReturnType<typeof customerDetection> = null;
      if (speaker === "customer" && customer === "auto") {
        detection = customerDetection(heard.language_code, heard.language_probability);
        if (!detection) {
          setDetectionFailed(true);
          setDetected(null);
          throw new Error("Customer language could not be detected confidently. Retry recording or select the language manually.");
        }
        setDetected(detection);
        setDetectionFailed(false);
      }
      if (speaker === "shopkeeper" && customer === "auto") throw new Error("Ask the customer to speak first, or select their language manually.");
      const source = speaker === "customer" ? customer : shopLanguage;
      const target = speaker === "customer" ? shopLanguage : customer;
      const terms = protectedTerms.split(",").map((term) => term.trim()).filter(Boolean);
      if (terms.length > 20 || terms.some((term) => term.length > 160)) throw new Error("Use up to 20 protected names or addresses, each at most 160 characters.");
      setStatus(`Translating ${speaker}…`);
      const result = source !== "auto" && source === target
        ? { original_text: text, translated_text: text, source_language: source, target_language: target, same_language: true }
        : await apiRequest<Translation>("/api/translation", token, {
          method: "POST", signal,
          body: JSON.stringify({
            text, source_language: source, target_language: target, protected_terms: terms,
            ...(detection ? { detected_language: detection.language, language_probability: detection.probability } : {}),
          }),
        });
      if (signal.aborted || operation.current !== id) return "";
      if (speaker === "customer" && source === "auto") {
        const language = supportedLanguage(result.source_language);
        if (!language) throw new Error("Could not identify a supported customer language. Retry or select it manually.");
        customerLanguageRef.current = language;
        setCustomerLanguage(language);
      }
      setTurns((current) => [...current.slice(-19), { ...result, speaker, id }]);
      setDrafts((current) => ({ ...current, [speaker]: "" }));
      setDetected(null);
      setDetectionFailed(false);
      setStatus(`Playing translation for the ${speaker === "customer" ? "shopkeeper" : "customer"}…`);
      const playbackFailure = await play(result.translated_text, result.target_language, id, signal, true);
      if (signal.aborted || operation.current !== id) return "";
      if (playbackFailure !== null) return playbackFailure;
      speakerRef.current = nextSpeaker(speaker);
      setActiveSpeaker(speakerRef.current);
      setStatus(`${speakerRef.current === "customer" ? "Customer" : "Shopkeeper"} speaks next.`);
      return null;
    } catch (failure) {
      if (signal.aborted || operation.current !== id) return "";
      const message = failure instanceof Error ? failure.message : "Conversation failed. Retry or type the message.";
      setError(message);
      setStatus("Conversation stopped.");
      return message;
    } finally {
      if (operation.current === id) setBusy(false);
    }
  }

  async function translate(speaker: Speaker) {
    const text = drafts[speaker].trim();
    if (!text || busy || voiceSession.active) return;
    if (speaker === "shopkeeper" && customerLanguage === "auto") {
      setError("Ask the customer to speak or type first, or select their language manually.");
      return;
    }
    if (speaker === "customer" && customerLanguage === "auto" && detectionFailed) {
      setError("Could not detect the language reliably. Retry recording or select the customer language manually.");
      return;
    }
    const terms = protectedTerms.split(",").map((term) => term.trim()).filter(Boolean);
    if (terms.length > 20 || terms.some((term) => term.length > 160)) {
      setError("Use up to 20 protected names or addresses, each at most 160 characters.");
      return;
    }
    const id = begin();
    const source = speaker === "shopkeeper" ? shopLanguage : customerLanguage;
    const target = speaker === "shopkeeper" ? customerLanguage : shopLanguage;
    setStatus(`Translating for the ${speaker === "shopkeeper" ? "customer" : "shopkeeper"}…`);
    try {
      const result = source !== "auto" && source === target
        ? { original_text: text, translated_text: text, source_language: source, target_language: target, same_language: true }
        : await apiRequest<Translation>("/api/translation", token, {
        method: "POST", signal: controller.current?.signal,
        body: JSON.stringify({
          text, source_language: source, target_language: target,
          protected_terms: terms,
          ...(speaker === "customer" && source === "auto" && detected
            ? { detected_language: detected.language, language_probability: detected.probability } : {}),
        }),
      });
      if (operation.current !== id) return;
      if (speaker === "customer" && source === "auto") {
        const resolved = supportedLanguage(result.source_language);
        if (!resolved) throw new Error("Could not identify a supported customer language. Retry or select it manually.");
        setCustomerLanguage(resolved);
      }
      setTurns((current) => [...current.slice(-19), { ...result, speaker, id }]);
      setDrafts((current) => ({ ...current, [speaker]: "" }));
      setDetected(null);
      setDetectionFailed(false);
      setStatus("Translated. Review the text and play it aloud.");
      try {
        await play(result.translated_text, target, id);
      } catch (failure) {
        if (operation.current === id) {
          setError(`Translation is ready, but speech could not load: ${failure instanceof Error ? failure.message : "Please retry playback."}`);
        }
      }
    } catch (failure) {
      if (operation.current === id) {
        setError(failure instanceof Error ? failure.message : "Translation failed. Please retry.");
        setStatus("Translation could not be completed.");
      }
    } finally { if (operation.current === id) setBusy(false); }
  }

  async function replay(turn: Turn) {
    const id = begin();
    setStatus("Loading translated speech…");
    try {
      await play(turn.translated_text, turn.target_language, id);
      if (operation.current === id) setStatus("Speech ready. Use the audio controls to play or pause.");
    } catch (failure) {
      if (operation.current === id) setError(failure instanceof Error ? failure.message : "Speech could not load.");
    } finally { if (operation.current === id) setBusy(false); }
  }

  async function record(speaker: Speaker) {
    if (busy || voiceSession.active) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError("Microphone recording is not supported here. Type the message instead, or use localhost/HTTPS.");
      return;
    }
    const id = begin();
    try {
      const tracks = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (operation.current !== id) { tracks.getTracks().forEach((track) => track.stop()); return; }
      stream.current = tracks;
      const capture = new MediaRecorder(tracks);
      const chunks: Blob[] = [];
      recorder.current = capture;
      capture.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      capture.onstop = async () => {
        tracks.getTracks().forEach((track) => track.stop());
        if (timeout.current) clearTimeout(timeout.current);
        if (operation.current !== id) return;
        setListening(null);
        setStatus("Transcribing audio. You can edit the words before translating.");
        try {
          const blob = new Blob(chunks, { type: capture.mimeType || "audio/webm" });
          if (!blob.size) throw new Error("No audio was captured. Please try again.");
          const data = new FormData();
          data.append("file", blob, capture.mimeType.includes("mp4") ? "conversation.mp4" : "conversation.webm");
          data.append("mode", "transcribe");
          const result = await apiRequest<{ transcript: string; language_code?: string | null; language_probability?: number | null }>("/api/voice/transcribe", token, {
            method: "POST", body: data, signal: controller.current?.signal,
          });
          if (operation.current !== id) return;
          setDrafts((current) => ({ ...current, [speaker]: result.transcript }));
          if (speaker === "customer" && customerLanguage === "auto") {
            const detection = customerDetection(result.language_code, result.language_probability);
            if (!detection) {
              setDetected(null);
              setDetectionFailed(true);
              setError("Customer language could not be detected confidently. Retry recording or select the language manually.");
              setStatus("Transcript ready; choose a language or retry.");
            } else {
              setDetected(detection);
              setDetectionFailed(false);
              setStatus(`Detected ${languageName(detection.language)}. Review the transcript, then translate.`);
            }
          } else setStatus("Transcript ready. Review or edit it, then choose Translate.");
        } catch (failure) {
          if (operation.current === id) setError(failure instanceof Error ? failure.message : "Transcription failed.");
        } finally { if (operation.current === id) setBusy(false); }
      };
      capture.onerror = () => {
        if (operation.current !== id) return;
        cancel();
        setError("Recording failed. Please retry or type your message.");
      };
      capture.start();
      setListening(speaker);
      setStatus(`Listening to the ${speaker}… Maximum 30 seconds.`);
      timeout.current = setTimeout(() => { if (capture.state === "recording") capture.stop(); }, 30000);
    } catch (failure) {
      stream.current?.getTracks().forEach((track) => track.stop());
      if (operation.current === id) {
        setError(failure instanceof Error ? `Cannot record: ${failure.message}` : "Microphone access was not granted.");
        setBusy(false);
      }
    }
  }

  return <section className="translator">
    <div className="page-heading">
      <div><div className="eyebrow">UNDERSTAND EACH OTHER</div><h1>Customer conversation</h1>
        <p>Speak different languages. Keep the conversation flowing.</p></div>
      <button type="button" className="button button-secondary" onClick={onExit}>Back to shop assistant</button>
    </div>
    <div className="alert-strip"><Languages size={20} /><div>
      <strong>Translation only — no sales, payments, or stock changes.</strong>
      <div>Review important details together. Saved product/customer names and numbers are protected; add other names or addresses below.</div>
    </div></div>
    <div className="translator-status">
      <button type="button" className={`button ${voiceSession.active ? "button-secondary" : "button-primary"}`}
        disabled={!voiceSession.active && busy}
        onClick={() => {
          if (voiceSession.active) {
            voiceSession.stop();
            operation.current++;
            audio.current?.pause();
            setBusy(false);
            setStatus("Conversation stopped.");
          } else {
            audio.current?.pause();
            speakerRef.current = "customer";
            setActiveSpeaker("customer");
            setError("");
            setStatus("Starting with the customer.");
            void voiceSession.start();
          }
        }}>{voiceSession.active ? "Stop conversation" : "Start conversation"}</button>
      <span role="status">{voiceSession.active ? `Active speaker: ${activeSpeaker}. ${voiceSession.status}` : voiceSession.status}</span>
    </div>
    <p className="panel-note">Automatic turns start with the customer and alternate after playback. Stop to choose either speaker manually.</p>
    <div className="translator-speakers">
      {(["shopkeeper", "customer"] as const).map((speaker) => {
        const source = speaker === "shopkeeper" ? shopLanguage : customerLanguage;
        const target = speaker === "shopkeeper" ? customerLanguage : shopLanguage;
        return <section className="panel translator-speaker" key={speaker}>
          <h2>{speaker === "shopkeeper" ? "Shopkeeper" : "Customer"} {voiceSession.active && activeSpeaker === speaker && <span className="badge badge-ok">Active speaker</span>}</h2>
          <label className="field">{speaker === "shopkeeper" ? "Shopkeeper language" : "Customer language"}
            <select value={source} disabled={busy || voiceSession.active} onChange={(event) => {
              if (speaker === "shopkeeper") setShopLanguage(event.target.value);
              else { customerLanguageRef.current = event.target.value; setCustomerLanguage(event.target.value); setDetected(null); setDetectionFailed(false); setError(""); }
            }}>
              {speaker === "customer" && <option value="auto">Auto detect</option>}
              {LANGUAGES.map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}
            </select></label>
          <label className="field">{speaker === "shopkeeper" ? "Shopkeeper message" : "Customer message"}
            <textarea maxLength={1000} rows={4} value={drafts[speaker]} disabled={busy || voiceSession.active}
              placeholder="Speak, review the transcript, or type here…"
              onChange={(event) => {
                setDrafts((current) => ({ ...current, [speaker]: event.target.value }));
                if (speaker === "customer") setDetected(null);
              }} /></label>
          <div className="translator-actions">
            <button type="button" className={`button ${listening === speaker ? "button-primary" : "button-secondary"}`}
              disabled={voiceSession.active || (busy && listening !== speaker)}
              onClick={() => {
                if (listening === speaker) {
                  if (recorder.current?.state === "recording") recorder.current.stop();
                } else void record(speaker);
              }}>
              {listening === speaker ? <Pause size={17} /> : <Mic size={17} />}
              {listening === speaker ? "Stop recording" : `Speak as ${speaker}`}
            </button>
            <button type="button" className="button button-primary" disabled={busy || voiceSession.active || !drafts[speaker].trim()}
              onClick={() => void translate(speaker)}><Send size={16} />Translate {speaker === "shopkeeper" ? "for customer" : "for shopkeeper"}</button>
          </div><div className="panel-note">To {target === "auto" ? "customer language (customer first)" : languageName(target)} · {drafts[speaker].length}/1000 characters</div>
        </section>;
      })}
    </div>
    <label className="field translator-terms">Keep these names / addresses unchanged (optional, comma-separated)
      <input value={protectedTerms} disabled={busy || voiceSession.active} maxLength={1000} placeholder="e.g. Aashirvaad, Priya, 12 Gandhi Road"
        onChange={(event) => setProtectedTerms(event.target.value)} />
    </label>
    <div className="translator-status"><span role="status">{status}</span>
      {busy && !voiceSession.active && <button className="button button-secondary" onClick={cancel}><X size={15} />Cancel</button>}
    </div>
    {error && <div role="alert" className="translator-error">{error}</div>}
    {audioUrl && <audio ref={audio} src={audioUrl} controls={!voiceSession.active} aria-label="Translated speech"
      onError={() => setError("This browser could not play the translated audio. Please retry playback.")}
      className="translator-audio" />}
    <section className="panel translator-history">
      <div className="panel-heading"><div><h2 className="panel-title">Conversation</h2>
        <p className="panel-note">Last 20 translations. Cleared when you leave this page; no conversation text is saved to the database.</p></div>
        <button className="button button-secondary" onClick={() => {
          voiceSession.stop(); cancel(); audio.current?.pause(); setTurns([]); setAudioUrl(""); setDrafts({ shopkeeper: "", customer: "" });
          customerLanguageRef.current = "auto"; speakerRef.current = "customer"; setActiveSpeaker("customer");
          setCustomerLanguage("auto"); setDetected(null); setDetectionFailed(false); setError(""); setStatus("New conversation. Ask the customer to speak or type first.");
        }}>New conversation</button></div>
      {!turns.length && <p className="empty-state">Choose who is speaking to start a two-way conversation.</p>}
      {turns.map((turn) => <article key={turn.id} className={`translator-turn ${turn.speaker}`}>
        <strong>{turn.speaker === "shopkeeper" ? "Shopkeeper → Customer" : "Customer → Shopkeeper"}</strong>
        <div className="panel-note">{languageName(turn.source_language)} · Original</div>
        <p>{turn.original_text}</p>
        <div className="panel-note">{languageName(turn.target_language)} · {turn.same_language ? "Same language, no translation needed" : "Translation"}</div>
        <p className="translator-result">{turn.translated_text}</p>
        <button className="button button-secondary" disabled={busy || voiceSession.active} onClick={() => void replay(turn)}><Volume2 size={16} />Play translation</button>
      </article>)}
      <div ref={lastTurn} />
    </section>
  </section>;
}
