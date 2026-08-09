"use client";

/**
 * TalkToAgent — a real voice conversation with a provisioned Supafone agent,
 * in the browser, over WebRTC.
 *
 * Why this exists: Supafone's managed telephony is currently disabled
 * (`403 managed Twilio is disabled`) and the account owns no numbers, so there
 * is no PSTN number to dial. The product API still exposes a free browser test
 * call that returns an Ultravox join URL — mic in, agent audio out, live
 * transcripts. That makes the built agent genuinely testable today.
 *
 * Two transcript sources are shown:
 *
 *  1. Ultravox — the agent's own ASR. This is what the agent actually "hears"
 *     and reasons over, so it is the ground truth for the conversation. It is
 *     internal to the speech-to-speech model and cannot be swapped out.
 *
 *  2. Deepgram nova-3 (`language=multi`) — an optional parallel tap on your
 *     microphone. nova-3 detects language per word across ten languages, so a
 *     caller who switches languages mid-sentence is still transcribed and every
 *     utterance comes back language-tagged. Off by default because it bills
 *     against the Labs minute balance by audio duration.
 *
 * The tap sends short self-contained clips to /api/transcribe rather than
 * streaming: Supafone's documented streaming socket (`WS /v1/stt/live`) returns
 * 404 on the deployed gateway. The API key stays server-side either way.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "idle" | "connecting" | "live" | "ended" | "error";

interface Line {
  speaker: "user" | "agent";
  text: string;
  isFinal: boolean;
}

interface NovaLine {
  text: string;
  languages: string[];
  seconds: number;
}

interface WhisperLine {
  text: string;
  at: string;
}

/** Minimal shape we rely on from ultravox-client (loaded dynamically). */
interface UvSession {
  joinCall(joinUrl: string): void;
  leaveCall(): Promise<void>;
  status: string;
  transcripts: { text: string; isFinal: boolean; speaker: string }[];
  toggleMicMute(): void;
  isMicMuted: boolean;
  sendText(text: string, options?: { urgency?: string; placement?: string }): void;
  addEventListener(type: string, cb: () => void): void;
}

/** Minimum gap between coaching turns. Each one bills ~1s of oracle time. */
const WATCH_INTERVAL_MS = 9000;
/** Don't coach before there's actually a conversation to read. */
const WATCH_MIN_TURNS = 2;
/**
 * The agent reads injected text as a user turn, so label it unmistakably.
 * Ultravox's own docs describe the watcher channel as a deferred
 * user_text_message — urgency LATER adds context without prompting speech.
 */
const DIRECTIVE_PREFIX = "[SUPERVISOR — silent note, do not read aloud]:";

/** Length of each nova-3 clip. Long enough to hold a full utterance. */
const NOVA_WINDOW_MS = 5000;
/** Below this a clip is almost certainly silence//container overhead — skip it. */
const MIN_CLIP_BYTES = 2000;

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

export function TalkToAgent({
  agentId,
  assistantName,
  businessName,
  guardrails,
  objective,
}: {
  agentId: string;
  assistantName: string;
  businessName: string;
  guardrails?: string;
  objective?: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // Deepgram nova-3 multilingual tap.
  const [novaOn, setNovaOn] = useState(false);
  const [novaLines, setNovaLines] = useState<NovaLine[]>([]);
  const [novaSeconds, setNovaSeconds] = useState(0);
  const [novaError, setNovaError] = useState<string | null>(null);

  // Self-healing watcher (the "second mind").
  const [watchOn, setWatchOn] = useState(true);
  const [whispers, setWhispers] = useState<WhisperLine[]>([]);
  const [watchTurns, setWatchTurns] = useState(0);
  const [watchError, setWatchError] = useState<string | null>(null);

  const sessionRef = useRef<UvSession | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchBusyRef = useRef(false);
  const watchOnRef = useRef(true);
  const lastCoachedRef = useRef("");
  const linesRef = useRef<Line[]>([]);
  const tapStreamRef = useRef<MediaStream | null>(null);
  const tapRecorderRef = useRef<MediaRecorder | null>(null);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapActiveRef = useRef(false);

  /* ------------------- self-healing watcher ------------------- */

  useEffect(() => {
    watchOnRef.current = watchOn;
  }, [watchOn]);

  /**
   * One coaching turn: read the conversation so far, ask the oracle whether
   * anything needs correcting, and if so slide the note to the agent silently.
   *
   * Deliberately degrade-safe — any failure here leaves the call untouched.
   */
  const coachOnce = useCallback(async () => {
    if (watchBusyRef.current || !watchOnRef.current) return;
    const session = sessionRef.current;
    if (!session) return;

    const finals = linesRef.current.filter((l) => l.isFinal);
    if (finals.length < WATCH_MIN_TURNS) return;

    const transcript = finals
      .map((l) => `${l.speaker === "agent" ? "agent" : "caller"}: ${l.text}`)
      .join("\n");
    // Nothing new was said since the last coaching turn — don't pay again.
    if (transcript === lastCoachedRef.current) return;

    watchBusyRef.current = true;
    lastCoachedRef.current = transcript;
    try {
      const res = await fetch("/api/watch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          guardrails,
          objective,
          sessionId: agentId,
          agent: assistantName,
        }),
      });
      const data = (await res.json()) as { directive?: string; error?: string };
      setWatchTurns((n) => n + 1);
      if (data.error) setWatchError(data.error);

      const directive = (data.directive ?? "").trim();
      if (!directive) return; // the agent is doing fine; say nothing

      // Inject as a deferred user turn so the caller never hears it.
      try {
        sessionRef.current?.sendText(`${DIRECTIVE_PREFIX} ${directive}`, { urgency: "later" });
      } catch {
        /* transports gone (call ended mid-flight) — drop it */
      }
      setWhispers((w) => [
        ...w,
        { text: directive, at: new Date().toLocaleTimeString([], { hour12: false }) },
      ]);
    } catch (e) {
      setWatchError(e instanceof Error ? e.message : String(e));
    } finally {
      watchBusyRef.current = false;
    }
  }, [agentId, assistantName, guardrails, objective]);

  const stopWatcher = useCallback(() => {
    if (watchTimerRef.current) {
      clearInterval(watchTimerRef.current);
      watchTimerRef.current = null;
    }
  }, []);

  const startWatcher = useCallback(() => {
    stopWatcher();
    watchTimerRef.current = setInterval(() => void coachOnce(), WATCH_INTERVAL_MS);
  }, [coachOnce, stopWatcher]);

  /* ---------------------- nova-3 multilingual tap ---------------------- */

  const sendClip = useCallback(async (blob: Blob) => {
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": blob.type || "application/octet-stream" },
        body: blob,
      });
      const data = (await res.json()) as {
        transcript?: string;
        languages?: string[];
        duration?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNovaSeconds((s) => s + (data.duration ?? 0));
      const text = (data.transcript ?? "").trim();
      if (text) {
        setNovaLines((l) => [
          ...l,
          { text, languages: data.languages ?? [], seconds: data.duration ?? 0 },
        ]);
      }
    } catch (e) {
      setNovaError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stopNovaTap = useCallback(() => {
    tapActiveRef.current = false;
    if (tapTimerRef.current) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = null;
    }
    const rec = tapRecorderRef.current;
    tapRecorderRef.current = null;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* already stopping */
      }
    }
    tapStreamRef.current?.getTracks().forEach((t) => t.stop());
    tapStreamRef.current = null;
  }, []);

  /**
   * A fresh MediaRecorder per window. Using one recorder with a timeslice
   * yields chunks that lack container headers after the first, which Deepgram
   * cannot decode standalone; restarting guarantees each clip is a complete,
   * independently decodable file.
   */
  const startNovaTap = useCallback(async () => {
    setNovaError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tapStreamRef.current = stream;
      tapActiveRef.current = true;
      const mime = pickRecorderMime();

      const cycle = () => {
        const active = tapActiveRef.current;
        const s = tapStreamRef.current;
        if (!active || !s) return;

        const rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
        tapRecorderRef.current = rec;
        const chunks: Blob[] = [];

        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        rec.onstop = () => {
          const blob = new Blob(chunks, { type: rec.mimeType });
          if (blob.size >= MIN_CLIP_BYTES) void sendClip(blob);
          cycle();
        };

        rec.start();
        tapTimerRef.current = setTimeout(() => {
          if (rec.state !== "inactive") rec.stop();
        }, NOVA_WINDOW_MS);
      };

      cycle();
    } catch (e) {
      tapActiveRef.current = false;
      setNovaError(
        e instanceof Error ? `Microphone unavailable for the tap: ${e.message}` : String(e),
      );
    }
  }, [sendClip]);

  /* ----------------------------- the call ----------------------------- */

  const cleanupTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hangUp = useCallback(async () => {
    cleanupTimer();
    stopNovaTap();
    stopWatcher();
    try {
      await sessionRef.current?.leaveCall();
    } catch {
      /* already gone */
    }
    sessionRef.current = null;
    setPhase("ended");
    setStatus("Call ended.");
  }, [cleanupTimer, stopNovaTap, stopWatcher]);

  // Never leave a live call, an open mic, or a polling watcher after unmount.
  useEffect(() => {
    return () => {
      cleanupTimer();
      stopNovaTap();
      stopWatcher();
      void sessionRef.current?.leaveCall().catch(() => {});
      sessionRef.current = null;
    };
  }, [cleanupTimer, stopNovaTap, stopWatcher]);

  const start = useCallback(async () => {
    setError(null);
    setLines([]);
    setNovaLines([]);
    setNovaSeconds(0);
    setWhispers([]);
    setWatchTurns(0);
    setWatchError(null);
    linesRef.current = [];
    lastCoachedRef.current = "";
    setPhase("connecting");
    setStatus("Requesting a session…");

    try {
      const res = await fetch("/api/talk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      const data = (await res.json()) as {
        joinUrl?: string;
        maxDurationSeconds?: number;
        freeCallsRemaining?: number;
        error?: string;
      };
      if (!res.ok || !data.joinUrl) throw new Error(data.error ?? `HTTP ${res.status}`);

      setRemaining(data.freeCallsRemaining ?? null);
      setStatus("Connecting audio… allow microphone access.");

      // Loaded on demand: the SDK touches browser-only APIs.
      const { UltravoxSession } = await import("ultravox-client");
      const session = new UltravoxSession() as unknown as UvSession;
      sessionRef.current = session;

      session.addEventListener("status", () => {
        const s = sessionRef.current?.status ?? "";
        setStatus(
          s === "listening"
            ? "Listening — go ahead and speak."
            : s === "thinking"
              ? "Thinking…"
              : s === "speaking"
                ? `${assistantName} is speaking…`
                : s,
        );
        if (s === "disconnected") {
          cleanupTimer();
          stopNovaTap();
          stopWatcher();
          setPhase((p) => (p === "live" ? "ended" : p));
        } else if (s && s !== "connecting" && s !== "disconnecting") {
          setPhase("live");
        }
      });

      session.addEventListener("transcripts", () => {
        const t = sessionRef.current?.transcripts ?? [];
        const mapped: Line[] = t.map((x) => ({
          speaker: x.speaker === "agent" ? "agent" : "user",
          text: x.text,
          isFinal: x.isFinal,
        }));
        // The watcher reads from a ref so its interval never captures stale state.
        linesRef.current = mapped.filter((l) => !l.text.startsWith(DIRECTIVE_PREFIX));
        setLines(linesRef.current);
      });

      session.addEventListener("error", () => {
        setError("The call dropped unexpectedly.");
        setPhase("error");
        cleanupTimer();
        stopNovaTap();
        stopWatcher();
      });

      session.joinCall(data.joinUrl);
      if (novaOn) void startNovaTap();
      if (watchOn) startWatcher();

      const cap = data.maxDurationSeconds ?? 180;
      setSecondsLeft(cap);
      timerRef.current = setInterval(() => {
        setSecondsLeft((s) => {
          if (s === null) return null;
          if (s <= 1) {
            void hangUp();
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      cleanupTimer();
      stopNovaTap();
      stopWatcher();
    }
  }, [
    agentId,
    assistantName,
    cleanupTimer,
    hangUp,
    novaOn,
    startNovaTap,
    stopNovaTap,
    startWatcher,
    stopWatcher,
    watchOn,
  ]);

  const toggleMute = useCallback(() => {
    sessionRef.current?.toggleMicMute();
    setMuted(sessionRef.current?.isMicMuted ?? false);
  }, []);

  const live = phase === "live" || phase === "connecting";

  // Let the tap be switched on or off mid-call.
  const onToggleNova = useCallback(
    (checked: boolean) => {
      setNovaOn(checked);
      if (!live) return;
      if (checked) void startNovaTap();
      else stopNovaTap();
    },
    [live, startNovaTap, stopNovaTap],
  );

  const onToggleWatch = useCallback(
    (checked: boolean) => {
      setWatchOn(checked);
      if (!live) return;
      if (checked) startWatcher();
      else stopWatcher();
    },
    [live, startWatcher, stopWatcher],
  );

  return (
    <div style={wrap}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={dot(phase)} aria-hidden="true" />
        <strong style={{ fontSize: 15 }}>
          Talk to {assistantName} · {businessName}
        </strong>
        {remaining !== null && (
          <span style={meta}>{remaining} free sessions left</span>
        )}
        {secondsLeft !== null && live && (
          <span style={meta}>
            {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")} left
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        {!live ? (
          <button type="button" onClick={start} style={primary}>
            {phase === "ended" || phase === "error" ? "Call again" : "🎙️ Start voice call"}
          </button>
        ) : (
          <>
            <button type="button" onClick={hangUp} style={danger}>
              Hang up
            </button>
            <button type="button" onClick={toggleMute} style={secondary}>
              {muted ? "Unmute mic" : "Mute mic"}
            </button>
          </>
        )}
      </div>

      <label style={toggleRow}>
        <input
          type="checkbox"
          checked={watchOn}
          onChange={(e) => onToggleWatch(e.target.checked)}
        />
        <span>
          <strong>Self-healing watcher</strong>
          <br />
          <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>
            A second mind reads the call every {WATCH_INTERVAL_MS / 1000}s and slides a silent
            correction to {assistantName} when needed. The caller never hears it. ~1s oracle time
            per coaching turn.
          </span>
        </span>
      </label>

      <label style={toggleRow}>
        <input
          type="checkbox"
          checked={novaOn}
          onChange={(e) => onToggleNova(e.target.checked)}
        />
        <span>
          <strong>Deepgram nova-3 multilingual tap</strong>
          <br />
          <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>
            Transcribes your mic with per-word language detection across 10 languages. Bills Labs
            minutes by audio duration.
          </span>
        </span>
      </label>

      {status && <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ink-soft)" }}>{status}</p>}
      {error && <p style={{ margin: "8px 0 0", fontSize: 12, color: "#9d4638" }}>⚠ {error}</p>}

      {lines.length > 0 && (
        <>
          <p style={sectionLabel}>Ultravox — what the agent hears</p>
          <div style={transcript}>
            {lines.map((l, i) => (
              <div
                key={i}
                style={{
                  margin: "0 0 6px",
                  fontSize: 13,
                  opacity: l.isFinal ? 1 : 0.6,
                  color: l.speaker === "agent" ? "var(--forest)" : "var(--ink)",
                }}
              >
                <strong>{l.speaker === "agent" ? assistantName : "You"}:</strong> {l.text}
              </div>
            ))}
          </div>
        </>
      )}

      {watchOn && (
        <>
          <p style={sectionLabel}>
            Watcher · silent directives
            {watchTurns > 0 && ` · ${watchTurns} coaching turn${watchTurns === 1 ? "" : "s"}`}
          </p>
          {watchError && (
            <p style={{ margin: "0 0 6px", fontSize: 12, color: "#9d4638" }}>⚠ {watchError}</p>
          )}
          <div style={transcript}>
            {whispers.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12, color: "var(--ink-soft)" }}>
                {live
                  ? "Watching. Silence here means the agent is doing fine."
                  : "Start the call to see the second mind at work."}
              </p>
            ) : (
              whispers.map((w, i) => (
                <div key={i} style={{ margin: "0 0 6px", fontSize: 13 }}>
                  <span style={{ ...badge, background: "var(--coral)" }}>whisper</span>
                  <span style={{ color: "var(--ink-soft)", fontSize: 11, marginRight: 6 }}>
                    {w.at}
                  </span>
                  {w.text}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {novaOn && (
        <>
          <p style={sectionLabel}>
            Deepgram nova-3 · language=multi
            {novaSeconds > 0 && ` · ${novaSeconds.toFixed(1)}s billed`}
          </p>
          {novaError && (
            <p style={{ margin: "0 0 6px", fontSize: 12, color: "#9d4638" }}>⚠ {novaError}</p>
          )}
          <div style={transcript}>
            {novaLines.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12, color: "var(--ink-soft)" }}>
                {live
                  ? `Listening in ${NOVA_WINDOW_MS / 1000}s windows…`
                  : "Start the call to capture multilingual transcripts."}
              </p>
            ) : (
              novaLines.map((l, i) => (
                <div key={i} style={{ margin: "0 0 6px", fontSize: 13 }}>
                  {l.languages.map((lang) => (
                    <span key={lang} style={badge}>
                      {lang}
                    </span>
                  ))}
                  {l.text}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

const wrap: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  borderRadius: 14,
  background: "var(--sage)",
  border: "1px solid var(--line)",
};
const meta: React.CSSProperties = { color: "var(--ink-soft)", fontSize: 11 };
const primary: React.CSSProperties = {
  border: 0,
  borderRadius: 999,
  padding: "11px 20px",
  background: "var(--forest)",
  color: "white",
  fontWeight: 700,
  cursor: "pointer",
};
const secondary: React.CSSProperties = {
  border: "1px solid var(--forest)",
  borderRadius: 999,
  padding: "10px 16px",
  background: "transparent",
  color: "var(--forest)",
  fontWeight: 700,
  cursor: "pointer",
};
const danger: React.CSSProperties = { ...primary, background: "var(--coral)" };
const toggleRow: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  marginTop: 14,
  fontSize: 13,
  cursor: "pointer",
};
const sectionLabel: React.CSSProperties = {
  margin: "14px 0 6px",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.6,
  color: "var(--ink-soft)",
};
const transcript: React.CSSProperties = {
  padding: 12,
  maxHeight: 220,
  overflowY: "auto",
  background: "var(--paper)",
  border: "1px solid var(--line)",
  borderRadius: 10,
};
const badge: React.CSSProperties = {
  display: "inline-block",
  marginRight: 6,
  padding: "1px 7px",
  borderRadius: 999,
  background: "var(--forest)",
  color: "white",
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
};

function dot(phase: Phase): React.CSSProperties {
  const bg =
    phase === "live"
      ? "#42a789"
      : phase === "connecting"
        ? "#e0a23c"
        : phase === "error"
          ? "#c4553f"
          : "#9aaba8";
  return { width: 10, height: 10, borderRadius: "50%", background: bg, flex: "0 0 auto" };
}

export default TalkToAgent;
