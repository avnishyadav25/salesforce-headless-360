"use client";

import { useRef, useState, type FormEvent } from "react";
import TracePanel, { type TraceEntry } from "@/components/TracePanel";
import type { BriefResponse, McpServerInfo, TraceEvent } from "@/lib/chat-types";
import Markdown from "@/components/Markdown";

interface BriefProps {
  model: string;
  servers: McpServerInfo[];
}

interface GeneratedBrief {
  accountName: string;
  text: string;
  model: string;
  durationMs: number;
}

const MAX_ACCOUNT_NAME = 120;

/** Same entries the chat builds from its stream, built from the brief's trace in one go. */
function toTraceEntries(events: TraceEvent[], turn: number): TraceEntry[] {
  const entries: TraceEntry[] = [];
  events.forEach((event, index) => {
    switch (event.type) {
      case "tool_call":
        entries.push({ kind: "tool", id: event.id, turn, server: event.server, name: event.name, input: event.input, status: "running" });
        break;
      case "tool_result": {
        const call = entries.find((entry) => entry.kind === "tool" && entry.id === event.toolUseId);
        if (call?.kind === "tool") {
          call.status = event.isError ? "error" : "ok";
          call.result = event.text;
        }
        break;
      }
      case "thinking":
        entries.push({ kind: "thinking", id: `thinking-${turn}-${index}`, turn, text: event.text });
        break;
    }
  });
  return entries;
}

export default function Brief({ model, servers }: BriefProps) {
  const [accountName, setAccountName] = useState("");
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState<GeneratedBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const runs = useRef(0);

  async function generate(event: FormEvent) {
    event.preventDefault();
    const name = accountName.trim();
    if (!name || busy) return;

    runs.current += 1;
    const run = runs.current;
    setBusy(true);
    setError(null);
    setBrief(null);
    setTrace([]);

    try {
      const response = await fetch("/api/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountName: name }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { message?: string } | null;
        if (response.status === 401) setSignedOut(true);
        setError(problem?.message ?? `Request failed (${response.status}).`);
        return;
      }
      const result = (await response.json()) as BriefResponse;
      const toolCalls = result.trace.filter((item) => item.type === "tool_call").length;
      setBrief({ accountName: name, text: result.brief, model: result.model, durationMs: result.durationMs });
      setTrace([
        ...toTraceEntries(result.trace, run),
        {
          kind: "info",
          id: `info-${run}`,
          turn: run,
          text: `Brief for "${name}": ${toolCalls} tool call(s) in ${(result.durationMs / 1000).toFixed(1)} s.`,
        },
      ]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  const locked = busy || signedOut;

  return (
    <main className="workspace">
      <section className="chat" aria-label="Meeting prep brief">
        <form className="composer brief-form" onSubmit={generate}>
          <label htmlFor="account-name" className="visually-hidden">
            Account name
          </label>
          <input
            id="account-name"
            value={accountName}
            onChange={(event) => setAccountName(event.target.value)}
            placeholder="Account name, e.g. Acme Global Tech"
            maxLength={MAX_ACCOUNT_NAME}
            autoComplete="off"
            disabled={locked}
          />
          <button type="submit" className="btn primary" disabled={locked || !accountName.trim()}>
            {busy ? "Generating" : "Generate"}
          </button>
        </form>

        <div className="messages" aria-live="polite">
          {brief ? (
            <>
              <article className="message assistant brief" aria-label={`Meeting brief for ${brief.accountName}`}>
                <Markdown text={brief.text} />
              </article>
              <p className="subtle mono-small brief-meta">
                {brief.model} · {(brief.durationMs / 1000).toFixed(1)} s · read-only
              </p>
            </>
          ) : busy ? (
            <div className="message assistant">
              <span className="typing" aria-label="Generating the brief">
                Reading Salesforce as you
              </span>
            </div>
          ) : (
            <div className="empty">
              <h2>Meeting prep brief</h2>
              <p className="subtle">
                Type an Account name. Claude reads the account, its pipeline and its open cases as you and writes a brief
                with the record Ids it used: Snapshot, Pipeline, Service, Risks, Suggested talking points. Read-only:
                nothing in the org changes.
              </p>
            </div>
          )}
          {error ? <div className="message note error">{error}</div> : null}
          {signedOut ? (
            <div className="message note error">
              Your Salesforce session ended. <a href="/api/auth/salesforce/login">Sign in again</a>.
            </div>
          ) : null}
        </div>
      </section>

      <TracePanel entries={trace} servers={servers} model={model} />
    </main>
  );
}
