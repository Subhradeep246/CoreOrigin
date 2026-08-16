"use client";

import { useCallback, useRef, useState } from "react";
import { TalkToAgent } from "@/components/TalkToAgent";
import { DeleteAgentButton } from "@/components/DeleteAgentButton";

/* ---- shapes mirrored loosely from lib/server/agent-factory ---- */

interface StageT {
  id: string;
  name: string;
  goal: string;
}
interface ToolT {
  name: string;
  when: string;
  description: string;
}
interface FaqT {
  q: string;
  a: string;
}
interface GraphT {
  business: {
    name: string;
    tagline?: string;
    summary: string;
    phone?: string;
    email?: string;
    address?: string;
    hours?: string;
    services?: string[];
  };
  assistant: { name: string; voice: string; persona: string; greeting: string };
  stages: StageT[];
  tools: ToolT[];
  faqs: FaqT[];
  guardrails: string[];
  languages?: string[];
  objective: { goal: string; criteria: { name: string; description?: string }[] };
}
interface ProvisionT {
  attempted: boolean;
  linked: boolean;
  agentId?: string;
  agentKey?: string;
  phoneNumber?: string;
  numberId?: string;
  message: string;
}
interface ResultT {
  url: string;
  agentLabel: string;
  graph: GraphT;
  agentPrompt: string;
  qa: unknown;
  portalUrl: string;
  voiceSampleWavBase64?: string;
  provision?: ProvisionT;
  call?: { attempted: boolean; ok: boolean; status: number; message: string };
}

interface FactoryEvent {
  step: string;
  status: string;
  detail?: string;
  data?: unknown;
}

const STEP_LABELS: Record<string, string> = {
  scrape: "Scrape website",
  knowledge: "Build knowledge base",
  graph: "Generate agent graph + tools",
  configure: "Configure voice agent",
  objective: "Set success objective",
  qa: "Adversarial QA suite",
  voice: "Render voice sample",
  provision: "Restructure hosted agent for this company",
  call: "Place live call",
  complete: "Done",
};
const STEP_ORDER = [
  "scrape",
  "knowledge",
  "graph",
  "configure",
  "objective",
  "qa",
  "voice",
  "provision",
  "call",
];

type StepState = "pending" | "running" | "done" | "skipped";

export default function FactoryPage() {
  const [url, setUrl] = useState("");
  const [phone, setPhone] = useState("");
  const [runQa, setRunQa] = useState(false);
  const [voice, setVoice] = useState(false);
  const [provision, setProvision] = useState(false);
  const [areaCode, setAreaCode] = useState("");
  const [call, setCall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, { state: StepState; detail?: string }>>({});
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<ResultT | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const setStep = useCallback((step: string, state: StepState, detail?: string) => {
    setSteps((prev) => ({ ...prev, [step]: { state, detail } }));
  }, []);

  const handleEvent = useCallback(
    (e: FactoryEvent) => {
      if (e.step === "result") {
        setResult(e.data as ResultT);
        return;
      }
      if (e.step === "error") {
        setError(e.detail ?? "Something went wrong.");
        return;
      }
      if (e.step === "complete") {
        setStep("complete", "done");
        return;
      }
      const state: StepState =
        e.status === "start" ? "running" : e.status === "skipped" ? "skipped" : "done";
      setStep(e.step, state, e.detail);
      if (e.detail) setLog((l) => [...l, `${e.step}: ${e.detail}`]);
    },
    [setStep],
  );

  const build = useCallback(async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setLog([]);
    setSteps(Object.fromEntries(STEP_ORDER.map((s) => [s, { state: "pending" as StepState }])));

    try {
      const res = await fetch("/api/factory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          phone: phone.trim() || undefined,
          qa: runQa,
          voice,
          provision,
          areaCode: areaCode.trim() || undefined,
          call,
        }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Request failed (${res.status}).`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            handleEvent(JSON.parse(trimmed) as FactoryEvent);
          } catch {
            /* ignore partial line */
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [url, phone, runQa, voice, provision, areaCode, call, busy, handleEvent]);

  const audioSrc = result?.voiceSampleWavBase64
    ? `data:audio/wav;base64,${result.voiceSampleWavBase64}`
    : null;

  return (
    <main style={{ minHeight: "100vh", background: "var(--cream)", color: "var(--ink)" }}>
      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "48px 24px 96px" }}>
        <p style={eyebrow}>Powered by Supafone Labs</p>
        <h1 style={h1}>
          One-Click <em style={{ color: "var(--forest)", fontStyle: "italic" }}>Agent Factory</em>
        </h1>
        <p style={lede}>
          Paste a company website. Supafone scrapes the site, builds a knowledge base, generates the
          agent graph and tools, then restructures the one hosted trial agent for that company
          (same WebRTC slot, new prompt, languages, and Voice Watcher). Talk in the browser — no
          delete required between companies. Buying a PSTN number is optional.
        </p>

        {/* input card */}
        <section style={card}>
          <label style={fieldLabel} htmlFor="url">
            Company website
          </label>
          <input
            id="url"
            style={input}
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
            onKeyDown={(e) => e.key === "Enter" && build()}
          />

          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 14 }}>
            <div style={{ flex: "1 1 240px" }}>
              <label style={fieldLabel} htmlFor="phone">
                Phone for live call (optional, E.164)
              </label>
              <input
                id="phone"
                style={input}
                placeholder="+16464279105"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={busy}
              />
            </div>
            <div style={{ flex: "0 1 160px" }}>
              <label style={fieldLabel} htmlFor="area">
                Area code (optional)
              </label>
              <input
                id="area"
                style={input}
                placeholder="415"
                value={areaCode}
                onChange={(e) => setAreaCode(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", margin: "16px 0 6px" }}>
            <Toggle label="Run adversarial QA" checked={runQa} onChange={setRunQa} disabled={busy} />
            <Toggle label="Render voice sample" checked={voice} onChange={setVoice} disabled={busy} />
            <Toggle
              label="Buy a phone number"
              checked={provision || call}
              onChange={setProvision}
              disabled={busy || call}
            />
            <Toggle
              label="Place live call"
              checked={call}
              onChange={setCall}
              disabled={busy || !phone.trim()}
            />
          </div>

          <button style={{ ...primaryBtn, opacity: busy || !url.trim() ? 0.55 : 1 }} onClick={build} disabled={busy || !url.trim()}>
            {busy ? "Building your agent…" : "Build my agent"}
          </button>

          {error && <p style={errorText}>⚠ {error}</p>}
        </section>

        {/* progress */}
        {(busy || Object.keys(steps).length > 0) && (
          <section style={{ ...card, marginTop: 20 }}>
            <h2 style={h2}>Pipeline</h2>
            <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 10 }}>
              {STEP_ORDER.filter(
                (s) =>
                  !(s === "qa" && !runQa) &&
                  !(s === "voice" && !voice) &&
                  !(s === "call" && !call),
              ).map((s) => {
                const st = steps[s]?.state ?? "pending";
                return (
                  <li key={s} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={dot(st)}>{st === "done" ? "✓" : st === "running" ? "…" : st === "skipped" ? "–" : ""}</span>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{STEP_LABELS[s]}</span>
                    {steps[s]?.detail && (
                      <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>— {steps[s]?.detail}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {/* result */}
        {result && (
          <section style={{ ...card, marginTop: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
              <div>
                <p style={eyebrowSmall}>Agent ready · {result.agentLabel}</p>
                <h2 style={{ ...h2, marginTop: 4 }}>{result.graph.business.name}</h2>
                <p style={{ color: "var(--ink-soft)", margin: "6px 0 0", maxWidth: 620 }}>
                  {result.graph.business.summary}
                </p>
              </div>
              <a href={result.portalUrl} target="_blank" rel="noreferrer" style={linkBtn}>
                Open in Supafone portal ↗
              </a>
            </div>

            {/* assistant + voice */}
            <div style={panel}>
              <strong>{result.graph.assistant.name}</strong>
              <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
                {" "}
                · voice {result.graph.assistant.voice} · {result.graph.assistant.persona}
                {result.graph.languages?.length
                  ? ` · languages ${result.graph.languages.join(", ")}`
                  : ""}
              </span>
              <p style={{ margin: "8px 0 0", fontStyle: "italic" }}>“{result.graph.assistant.greeting}”</p>
              {audioSrc && (
                <audio ref={audioRef} controls src={audioSrc} style={{ marginTop: 10, width: "100%" }} />
              )}
            </div>

            {/* stages + tools */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
              <div>
                <h3 style={h3}>Call flow</h3>
                <ol style={{ paddingLeft: 18, margin: 0, display: "grid", gap: 6 }}>
                  {result.graph.stages.map((s) => (
                    <li key={s.id ?? s.name}>
                      <strong>{s.name}</strong> — <span style={{ color: "var(--ink-soft)" }}>{s.goal}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <div>
                <h3 style={h3}>Tools</h3>
                <ul style={{ paddingLeft: 18, margin: 0, display: "grid", gap: 6 }}>
                  {result.graph.tools.map((t) => (
                    <li key={t.name}>
                      <code style={code}>{t.name}</code>{" "}
                      <span style={{ color: "var(--ink-soft)" }}>— {t.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* faqs */}
            {result.graph.faqs.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <h3 style={h3}>Knowledge base</h3>
                <div style={{ display: "grid", gap: 8 }}>
                  {result.graph.faqs.map((f, i) => (
                    <div key={i} style={{ fontSize: 13 }}>
                      <strong>Q: {f.q}</strong>
                      <div style={{ color: "var(--ink-soft)" }}>A: {f.a}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* the callable number — the payoff of the whole demo */}
            {result.provision && (
              result.provision.linked && result.provision.phoneNumber ? (
                <div style={{ ...panel, background: "#e3f4ee", textAlign: "center" }}>
                  <p style={{ ...eyebrowSmall, margin: 0 }}>Your AI receptionist is live</p>
                  <a
                    href={`tel:${result.provision.phoneNumber}`}
                    style={{
                      display: "block",
                      margin: "8px 0 4px",
                      fontSize: 30,
                      fontWeight: 750,
                      letterSpacing: "-.02em",
                      color: "var(--forest)",
                      textDecoration: "none",
                    }}
                  >
                    {result.provision.phoneNumber}
                  </a>
                  <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
                    Call it and {result.graph.assistant.name} answers · agent {result.provision.agentId}
                  </span>
                </div>
              ) : (
                <div style={{ ...panel, background: "var(--coral-soft)" }}>
                  <strong>
                    {result.provision.agentId ? "Agent launched, but no number." : "Number not provisioned."}
                  </strong>
                  <p style={{ margin: "6px 0 0", fontSize: 13 }}>{result.provision.message}</p>
                  {!result.provision.linked ? (
                    <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ink-soft)" }}>
                      The product account is <code style={code}>subhradeep246@gmail.com</code>. Use a Labs key
                      issued to that email, then <code style={code}>npm run link -- --create</code>.
                    </p>
                  ) : (
                    <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ink-soft)" }}>
                      Supafone&apos;s managed telephony is currently disabled, so no PSTN number can be
                      bought right now. The agent itself is live — talk to it below.
                    </p>
                  )}
                </div>
              )
            )}

            {/* Live browser voice — works with no telephony and no number. */}
            {result.provision?.agentId ? (
              <>
                <TalkToAgent
                  agentId={result.provision.agentId}
                  assistantName={result.graph.assistant.name}
                  businessName={result.graph.business.name}
                  guardrails={result.graph.guardrails?.join("; ")}
                  objective={result.graph.objective?.goal}
                  languages={result.graph.languages}
                  novaDefault
                />
                <DeleteAgentButton
                  agentId={result.provision.agentId}
                  agentKey={result.provision.agentKey}
                  label="Delete agent (optional — only if you want a blank slot)"
                  onDeleted={() =>
                    setResult((prev) =>
                      prev?.provision
                        ? {
                            ...prev,
                            provision: {
                              ...prev.provision,
                              agentId: undefined,
                              agentKey: undefined,
                              phoneNumber: undefined,
                              message: "Agent deleted. The trial slot is free — scrape the next site.",
                            },
                          }
                        : prev,
                    )
                  }
                />
              </>
            ) : result.provision && !result.provision.linked ? (
              <div style={{ ...panel, background: "var(--coral-soft)" }}>
                <strong>WebRTC talk needs a linked product account.</strong>
                <p style={{ margin: "6px 0 0", fontSize: 13 }}>{result.provision.message}</p>
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ink-soft)" }}>
                  Matching is by email: the Labs key must belong to{" "}
                  <code style={code}>subhradeep246@gmail.com</code>. Then run{" "}
                  <code style={code}>npm run link -- --create</code> and rebuild.
                </p>
              </div>
            ) : null}

            {/* call status */}
            {result.call && (
              <div style={{ ...panel, background: result.call.ok ? "#e3f4ee" : "var(--coral-soft)" }}>
                <strong>Live call:</strong> {result.call.ok ? "placed ✓" : "not placed"} — {result.call.message}
              </div>
            )}

            {/* qa */}
            {result.qa != null && (
              <details style={{ marginTop: 16 }}>
                <summary style={{ cursor: "pointer", fontWeight: 700 }}>Adversarial QA results</summary>
                <pre style={pre}>{JSON.stringify(result.qa, null, 2)}</pre>
              </details>
            )}

            {/* prompt */}
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer", fontWeight: 700 }}>
                Compiled agent prompt ({result.agentPrompt.length} chars)
              </summary>
              <pre style={pre}>{result.agentPrompt}</pre>
            </details>
          </section>
        )}
      </div>
    </main>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: props.disabled ? "not-allowed" : "pointer", opacity: props.disabled ? 0.5 : 1 }}>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        disabled={props.disabled}
        style={{ width: 16, height: 16, accentColor: "var(--forest)" }}
      />
      {props.label}
    </label>
  );
}

/* ---- inline styles (uses global CSS vars from globals.css) ---- */

const eyebrow: React.CSSProperties = {
  color: "#39746c",
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: ".12em",
  textTransform: "uppercase",
  margin: "0 0 12px",
};
const eyebrowSmall: React.CSSProperties = { ...eyebrow, fontSize: 10, margin: 0 };
const h1: React.CSSProperties = { margin: 0, fontSize: "clamp(40px,6vw,68px)", lineHeight: 1, letterSpacing: "-.05em", fontWeight: 650 };
const h2: React.CSSProperties = { margin: 0, fontSize: 24, letterSpacing: "-.03em" };
const h3: React.CSSProperties = { margin: "0 0 8px", fontSize: 15 };
const lede: React.CSSProperties = { maxWidth: 680, margin: "22px 0 30px", color: "var(--ink-soft)", fontSize: 17, lineHeight: 1.65 };
const card: React.CSSProperties = { background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 20, padding: 24, boxShadow: "var(--shadow)" };
const panel: React.CSSProperties = { marginTop: 16, padding: 16, background: "var(--sage)", borderRadius: 14 };
const fieldLabel: React.CSSProperties = { display: "block", color: "#4d625f", fontSize: 12, fontWeight: 700, marginBottom: 6 };
const input: React.CSSProperties = { width: "100%", height: 46, padding: "0 14px", border: "1px solid #d9e2dc", borderRadius: 12, background: "#fbfcf8", color: "var(--ink)", outline: 0, fontSize: 15 };
const primaryBtn: React.CSSProperties = { marginTop: 18, minHeight: 50, width: "100%", border: 0, borderRadius: 999, background: "var(--forest)", color: "white", fontWeight: 750, fontSize: 15, cursor: "pointer", boxShadow: "0 10px 24px rgba(23,76,72,.18)" };
const linkBtn: React.CSSProperties = { alignSelf: "flex-start", border: "1px solid var(--forest)", borderRadius: 999, padding: "10px 16px", color: "var(--forest)", textDecoration: "none", fontWeight: 700, fontSize: 13, height: "fit-content" };
const errorText: React.CSSProperties = { marginTop: 12, color: "#9d4638", fontSize: 13 };
const code: React.CSSProperties = { background: "#eef4ef", padding: "1px 6px", borderRadius: 6, fontFamily: "var(--font-geist-mono), monospace", fontSize: 12 };
const pre: React.CSSProperties = { marginTop: 10, padding: 14, background: "#0f3a37", color: "#daf0e8", borderRadius: 12, fontSize: 12, lineHeight: 1.5, overflowX: "auto", whiteSpace: "pre-wrap" };

function dot(state: StepState): React.CSSProperties {
  const bg = state === "done" ? "#42a789" : state === "running" ? "#e0a23c" : state === "skipped" ? "#9aaba8" : "#d3ddd7";
  return { width: 22, height: 22, borderRadius: "50%", background: bg, color: "white", display: "grid", placeItems: "center", fontSize: 12, flex: "0 0 auto" };
}
