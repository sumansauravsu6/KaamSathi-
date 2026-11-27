"use client";

import { useEffect, useRef, useState } from "react";
import { voiceTurnReady } from "./voice-helpers";

// onAudio returns null to keep listening, or a stop reason ("" means stopped silently by the user/navigation).
export function useVoiceSession(onAudio: (audio: Blob, signal: AbortSignal) => Promise<string | null>) {
  const callback = useRef(onAudio);
  callback.current = onAudio;
  const session = useRef<AbortController | null>(null);
  const endTurn = useRef<(() => void) | null>(null);
  const [active, setActive] = useState(false);
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("");

  function stop() {
    session.current?.abort();
    session.current = null;
    setActive(false);
    setListening(false);
    setStatus("Conversation stopped.");
  }

  useEffect(() => () => { session.current?.abort(); session.current = null; }, []);

  async function capture(signal: AbortSignal): Promise<Blob | null> {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.AudioContext) {
      throw new Error("Continuous recording is unavailable. Use the manual microphone or type instead.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (signal.aborted) { stream.getTracks().forEach((track) => track.stop()); throw new Error("Stopped"); }
    let context: AudioContext;
    try { context = new AudioContext(); } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
    try { await context.resume(); } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
      throw error;
    }
    if (signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
      throw new Error("Stopped");
    }
    return new Promise<Blob | null>((resolve, reject) => {
      let recorder: MediaRecorder;
      try { recorder = new MediaRecorder(stream); } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
        reject(error);
        return;
      }
      let source: MediaStreamAudioSourceNode;
      let analyser: AnalyserNode;
      try {
        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
      } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
        reject(error);
        return;
      }
      analyser.fftSize = 1024;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const chunks: Blob[] = [];
      let interval = 0;
      let deadline = 0;
      let heard = false;
      let lastSound = 0;
      let reason = "";
      const started = Date.now();
      const finish = () => { if (recorder.state === "recording") recorder.stop(); };
      const cleanup = () => {
        clearInterval(interval);
        clearTimeout(deadline);
        if (endTurn.current === finish) {
          endTurn.current = null;
          setListening(false);
        }
        signal.removeEventListener("abort", abort);
        stream.getTracks().forEach((track) => track.stop());
        source.disconnect();
        void context.close();
      };
      const abort = () => { reason = "Stopped"; if (recorder.state !== "inactive") recorder.stop(); };
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { reason = "Recording failed. Please retry or type."; if (recorder.state !== "inactive") recorder.stop(); };
      recorder.onstop = () => {
        cleanup();
        if (reason) { reject(new Error(reason)); return; }
        if (!heard) { resolve(null); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (!blob.size) reject(new Error("No audio was captured. Please try again."));
        else resolve(blob);
      };
      signal.addEventListener("abort", abort, { once: true });
      try { recorder.start(); } catch (error) { cleanup(); reject(error); return; }
      const monitor = () => {
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
        const now = Date.now();
        if (Math.sqrt(energy / samples.length) > 0.015) { heard = true; lastSound = now; }
        if (voiceTurnReady(now - started, heard ? now - lastSound : null)) finish();
      };
      endTurn.current = finish;
      setListening(true);
      interval = window.setInterval(monitor, 50);
      deadline = window.setTimeout(finish, 30000);
      if (signal.aborted) abort();
    });
  }

  async function start() {
    if (session.current) return;
    const controller = new AbortController();
    session.current = controller;
    setActive(true);
    try {
      while (!controller.signal.aborted) {
        setStatus("Listening · take your time. Tap Send now when you finish, or pause for 3 seconds.");
        const audio = await capture(controller.signal);
        if (controller.signal.aborted) break;
        if (!audio) continue;
        setStatus("Understanding and replying…");
        const stopReason = await callback.current(audio, controller.signal);
        if (stopReason !== null) {
          if (!controller.signal.aborted) setStatus(stopReason ? `Conversation stopped: ${stopReason}` : "Conversation stopped.");
          break;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : "Microphone failed. Please type instead.");
    } finally {
      if (session.current === controller) {
        session.current = null;
        setActive(false);
      }
    }
  }
  return { active, listening, status, start, stop, finishTurn: () => endTurn.current?.() };
}
