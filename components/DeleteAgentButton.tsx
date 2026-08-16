"use client";

import { useCallback, useState } from "react";

/**
 * Trial accounts hold one hosted agent. Delete frees the slot so the next
 * scrape can launch a different receptionist.
 */
export function DeleteAgentButton({
  agentId,
  agentKey,
  label,
  onDeleted,
}: {
  agentId?: string;
  agentKey?: string;
  label?: string;
  onDeleted?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const remove = useCallback(async () => {
    if (busy || done) return;
    const ok = window.confirm(
      "Delete this hosted agent and leave the trial slot empty? You usually do not need this — scrape a new company to restructure the same agent.",
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/talk", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, agentKey }),
      });
      const data = (await res.json()) as { ok?: boolean; detail?: string; error?: string };
      if (!res.ok || data.ok === false) {
        throw new Error(data.detail ?? data.error ?? `HTTP ${res.status}`);
      }
      setDone(true);
      onDeleted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [agentId, agentKey, busy, done, onDeleted]);

  if (done) {
    return (
      <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--forest)" }}>
        Agent deleted. The trial slot is free — scrape the next site.
      </p>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button type="button" onClick={() => void remove()} disabled={busy} style={btn}>
        {busy ? "Deleting…" : label ?? "Delete agent (free the slot)"}
      </button>
      {error && <p style={{ margin: "8px 0 0", fontSize: 12, color: "#9d4638" }}>⚠ {error}</p>}
    </div>
  );
}

const btn: React.CSSProperties = {
  border: "1px solid #9d4638",
  borderRadius: 999,
  padding: "10px 16px",
  background: "transparent",
  color: "#9d4638",
  fontWeight: 700,
  cursor: "pointer",
};
