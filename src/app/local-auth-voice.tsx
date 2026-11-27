"use client";

import { useEffect, useRef, useState } from "react";

interface LocalRecognition extends EventTarget {
  lang: string;
  processLocally: boolean;
  onresult: ((event: LocalResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
interface LocalResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface LocalRecognitionConstructor {
  new(): LocalRecognition;
  available(options: { langs: string[]; processLocally: true }): Promise<string>;
  install(options: { langs: string[]; processLocally: true }): Promise<boolean>;
}

export default function LocalAuthVoice({ onText, registerStop, onBeforeStart }: {
  onText: (text: string) => void;
  registerStop: (stop: () => void) => void;
  onBeforeStart: () => void;
}) {
  const recognition = useRef<LocalRecognition | null>(null);
  const generation = useRef(0);
  const pendingCheck = useRef<{ cancel: () => void } | null>(null);
  const [status, setStatus] = useState("");
  function stop() {
    generation.current++;
    pendingCheck.current?.cancel();
    recognition.current?.abort();
    recognition.current = null;
    setStatus("");
  }
  useEffect(() => {
    registerStop(stop);
    return () => { generation.current++; pendingCheck.current?.cancel(); recognition.current?.abort(); recognition.current = null; };
    // The parent stores a stable stop callback for password focus and submission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function checkAvailability(Recognition: LocalRecognitionConstructor, options: { langs: string[]; processLocally: true }): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (pendingCheck.current?.cancel === cancel) pendingCheck.current = null;
        action();
      };
      const cancel = () => finish(() => reject(new Error("Cancelled.")));
      const timer = setTimeout(() => finish(() => reject(new Error("On-device speech support check timed out."))), 5000);
      pendingCheck.current = { cancel };
      try {
        Promise.resolve(Recognition.available(options)).then(
          (value) => finish(() => resolve(value)),
          (error: unknown) => finish(() => reject(error)),
        );
      } catch (error) { finish(() => reject(error)); }
    });
  }

  async function start() {
    onBeforeStart();
    const id = generation.current;
    const browser = window as Window & { SpeechRecognition?: LocalRecognitionConstructor; webkitSpeechRecognition?: LocalRecognitionConstructor };
    const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!Recognition || typeof Recognition.available !== "function" || typeof Recognition.install !== "function") {
      setStatus("On-device speech recognition is unavailable. Please type instead.");
      return;
    }
    try {
      setStatus("Checking on-device speech support…");
      const options = { langs: ["en-IN"], processLocally: true as const };
      let availability = await checkAvailability(Recognition, options);
      if (id !== generation.current) return;
      if (availability === "downloadable" || availability === "downloading") {
        setStatus("Preparing on-device speech recognition…");
        if (!await Recognition.install(options)) throw new Error("On-device language download failed.");
        if (id !== generation.current) return;
        availability = await checkAvailability(Recognition, options);
      }
      if (id !== generation.current) return;
      if (availability !== "available") throw new Error("On-device recognition is not available.");
      const instance = new Recognition();
      if (!("processLocally" in instance)) throw new Error("This browser cannot guarantee on-device recognition.");
      instance.processLocally = true;
      instance.lang = "en-IN";
      instance.onresult = (event) => {
        if (id === generation.current) onText(event.results[0]?.[0]?.transcript || "");
      };
      instance.onerror = (event) => {
        if (id === generation.current) setStatus(`On-device speech failed (${event.error}). Please type instead.`);
      };
      instance.onend = () => { if (id === generation.current) recognition.current = null; };
      recognition.current = instance;
      instance.start();
      setStatus("Listening on this device. Check the result before continuing.");
    } catch (error) {
      if (id === generation.current) setStatus(`${error instanceof Error ? error.message : "On-device speech is unavailable."} Please type instead.`);
    }
  }
  return <div className="auth-voice"><button type="button" className="text-link" onClick={() => void start()}>Speak this field on device</button>
    <button type="button" className="text-link" onClick={stop}>Stop</button>
    {status && <span role="status">{status}</span>}</div>;
}
