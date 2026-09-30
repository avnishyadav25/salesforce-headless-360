"use client";

import type { McpServerInfo, WriteAudit } from "@/lib/chat-types";

export type TraceEntry =
  | {
      kind: "tool";
      id: string;
      turn: number;
      server: string;
      name: string;
      input: unknown;
      status: "running" | "ok" | "error";
      result?: string;
    }
  | { kind: "proposal"; id: string; turn: number; tool: string; server: string; status: "pending" | "approved" | "rejected" }
  | { kind: "thinking"; id: string; turn: number; text: string }
  | { kind: "info"; id: string; turn: number; text: string }
  | { kind: "audit"; id: string; turn: number; audit: WriteAudit };

interface TracePanelProps {
  entries: TraceEntry[];
  servers: McpServerInfo[];
  model: string;
}

const SHORT_SERVER: Record<string, string> = {
  "salesforce-sobject": "sobject-all",
  "salesforce-custom": "custom",
};

function pretty(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function prettyResult(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function AuditLine({ audit }: { audit: WriteAudit }) {
  if (audit.executed.length === 0) {
    return <p className="trace-note warn">Approved {audit.approved.tool}, but no write tool was called.</p>;
  }
  const allMatch = audit.executed.every((item) => item.matchesApproval);
  return (
    <p className={`trace-note ${allMatch && audit.executed.length === 1 ? "ok" : "warn"}`}>
      {allMatch && audit.executed.length === 1
        ? `Executed exactly as approved: ${audit.approved.tool}.`
        : `Check this write: ${audit.executed.length} call(s), ${audit.executed.filter((item) => !item.matchesApproval).length} differ from the approved arguments.`}
    </p>
  );
}

export default function TracePanel({ entries, servers, model }: TracePanelProps) {
  return (
    <aside className="trace" aria-label="Tool call trace">
      <div className="trace-head">
        <h2>Tool trace</h2>
        <span className="mono-small subtle">{model}</span>
      </div>
      <ul className="server-list">
        {servers.map((server) => (
          <li key={server.name}>
            <span className="mono-small">{server.name}</span>
            <span className="subtle mono-small" title={server.url}>
              {server.label}
            </span>
          </li>
        ))}
      </ul>

      {entries.length === 0 ? (
        <p className="subtle trace-empty">
          MCP tool calls appear here with their inputs and outputs. Claude calls the Salesforce servers directly through
          Anthropic&apos;s MCP connector.
        </p>
      ) : (
        <ol className="trace-list">
          {entries.map((entry) => {
            switch (entry.kind) {
              case "tool":
                return (
                  <li key={entry.id} className="trace-item">
                    <div className="trace-row">
                      <span className={`pill ${entry.status}`}>{entry.status}</span>
                      <span className="mono-small">
                        <span className="subtle">{SHORT_SERVER[entry.server] ?? entry.server} · </span>
                        {entry.name}
                      </span>
                      <span className="subtle mono-small turn">#{entry.turn}</span>
                    </div>
                    <details>
                      <summary>Input</summary>
                      <pre className="code">{pretty(entry.input)}</pre>
                    </details>
                    {entry.result !== undefined ? (
                      <details>
                        <summary>{entry.status === "error" ? "Error" : "Output"}</summary>
                        <pre className="code">{prettyResult(entry.result)}</pre>
                      </details>
                    ) : null}
                  </li>
                );
              case "proposal":
                return (
                  <li key={entry.id} className="trace-item">
                    <div className="trace-row">
                      <span className={`pill ${entry.status === "approved" ? "ok" : entry.status === "rejected" ? "error" : "accent"}`}>
                        {entry.status}
                      </span>
                      <span className="mono-small">
                        <span className="subtle">proposal · </span>
                        {entry.tool}
                      </span>
                      <span className="subtle mono-small turn">#{entry.turn}</span>
                    </div>
                  </li>
                );
              case "thinking":
                return (
                  <li key={entry.id} className="trace-item">
                    <details>
                      <summary>Reasoning summary #{entry.turn}</summary>
                      <p className="trace-text">{entry.text}</p>
                    </details>
                  </li>
                );
              case "audit":
                return (
                  <li key={entry.id} className="trace-item">
                    <AuditLine audit={entry.audit} />
                  </li>
                );
              default:
                return (
                  <li key={entry.id} className="trace-item">
                    <p className="trace-note">{entry.text}</p>
                  </li>
                );
            }
          })}
        </ol>
      )}
    </aside>
  );
}
