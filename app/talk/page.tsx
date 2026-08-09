"use client";

/**
 * /talk — call an agent that already exists on the account.
 *
 * Separate from /factory on purpose: reaching the voice button via /factory
 * means re-running the oracle pipeline, which spends Labs trial minutes. This
 * page spends none — it lists the hosted agents and starts a browser voice
 * session against whichever one you pick.
 */

import { useCallback, useEffect, useState } from "react";
import { TalkToAgent } from "@/components/TalkToAgent";

interface Agent {
  id: string;
  name: string;
  assistantName: string;
  businessName: string;
  phoneNumber: string | null;
  guardrails: string;
  objective: string;
}

export default function TalkPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/talk");
      const data = (await res.json()) as { agents?: Agent[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const list = data.agents ?? [];
      setAgents(list);
      setSelected((s) => s || list[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const agent = agents.find((a) => a.id === selected);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 20px 80px" }}>
      <h1 style={{ margin: 0, fontSize: 30, letterSpacing: -0.5 }}>Talk to an agent</h1>
      <p style={{ color: "var(--ink-soft)", fontSize: 14, lineHeight: 1.6 }}>
        A real voice conversation in the browser over WebRTC — microphone in, agent audio out,
        live transcripts. No phone number required, and it spends no Labs oracle minutes.
      </p>

      {loading && <p style={{ fontSize: 13 }}>Loading agents…</p>}
      {error && <p style={{ fontSize: 13, color: "#9d4638" }}>⚠ {error}</p>}

      {!loading && agents.length === 0 && !error && (
        <div style={card}>
          <strong>No agents on this account yet.</strong>
          <p style={{ margin: "6px 0 0", fontSize: 13 }}>
            Build one at <a href="/factory">/factory</a>, or from the CLI:
          </p>
          <pre style={pre}>npm run factory -- --url https://basecamp.com --no-qa --provision</pre>
        </div>
      )}

      {agents.length > 0 && (
        <>
          <label style={{ display: "block", marginTop: 24, fontSize: 12, fontWeight: 700 }}>
            Agent
          </label>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={select}
            aria-label="Choose an agent to call"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {a.assistantName}
                {a.phoneNumber ? ` (${a.phoneNumber})` : ""}
              </option>
            ))}
          </select>

          {agent && (
            <>
              <p style={{ marginTop: 10, fontSize: 11, color: "var(--ink-soft)" }}>
                agent id <code>{agent.id}</code>
                {!agent.phoneNumber && " · no PSTN number attached (managed telephony is down)"}
              </p>
              <TalkToAgent
                key={agent.id}
                agentId={agent.id}
                assistantName={agent.assistantName}
                businessName={agent.businessName || agent.name}
                guardrails={agent.guardrails}
                objective={agent.objective}
              />
            </>
          )}
        </>
      )}

      <p style={{ marginTop: 28, fontSize: 12, color: "var(--ink-soft)" }}>
        Free browser sessions are capped at 3 minutes each, 10 per account.
      </p>
    </main>
  );
}

const card: React.CSSProperties = {
  marginTop: 20,
  padding: 16,
  borderRadius: 14,
  background: "var(--sage)",
  border: "1px solid var(--line)",
};
const pre: React.CSSProperties = {
  margin: "10px 0 0",
  padding: 10,
  background: "var(--paper)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  fontSize: 12,
  overflowX: "auto",
};
const select: React.CSSProperties = {
  width: "100%",
  marginTop: 6,
  padding: "11px 12px",
  borderRadius: 10,
  border: "1px solid var(--line)",
  background: "var(--paper)",
  fontSize: 14,
};
