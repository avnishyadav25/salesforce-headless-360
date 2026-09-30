"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import ProposalCard from "@/components/ProposalCard";
import TracePanel, { type TraceEntry } from "@/components/TracePanel";
import type { BetaMessageParam, ChatDecision, ChatStreamEvent, McpServerInfo, Proposal } from "@/lib/chat-types";
import { readNdjson } from "@/lib/ndjson";

interface ChatItem {
  id: string;
  role: "user" | "assistant" | "note";
  text: string;
  streaming?: boolean;
  tone?: "info" | "error";
}

interface ChatProps {
  model: string;
  servers: McpServerInfo[];
}

const SUGGESTIONS = [
  "How healthy is the Acme account?",
  "Show my open opportunities closing this quarter, biggest first.",
  "Who am I signed in as, and which profile do I have?",
  "Create a follow-up task on Acme to send the renewal quote next Friday.",
];

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idCounter += 1)}`;

export default function Chat({ model, servers }: ChatProps) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [signedOut, setSignedOut] = useState(false);

  // The API transcript (including tool blocks) lives only in memory in this tab.
  const transcript = useRef<BetaMessageParam[]>([]);
  const turn = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items, proposals]);

  const updateItem = (id: string, change: (item: ChatItem) => ChatItem) =>
    setItems((current) => current.map((item) => (item.id === id ? change(item) : item)));

  const addNote = (text: string, tone: ChatItem["tone"] = "info") =>
    setItems((current) => [...current, { id: nextId("note"), role: "note", text, tone }]);

  const addTrace = (entry: TraceEntry) => setTrace((current) => [...current, entry]);

  async function send(payload: { userText: string } | { decision: ChatDecision }) {
    setBusy(true);
    turn.current += 1;
    const turnNumber = turn.current;
    const assistantId = nextId("assistant");
    const outcome = { completed: false };

    setItems((current) => [
      ...current,
      ...("userText" in payload ? [{ id: nextId("user"), role: "user" as const, text: payload.userText }] : []),
      { id: assistantId, role: "assistant", text: "", streaming: true },
    ]);

    const handle = (event: ChatStreamEvent) => {
      switch (event.type) {
        case "start":
          if (event.tokenRefreshed) {
            addTrace({ kind: "info", id: nextId("info"), turn: turnNumber, text: "Salesforce access token refreshed before this request." });
          }
          if (event.writeEnabled) {
            addTrace({
              kind: "info",
              id: nextId("info"),
              turn: turnNumber,
              text: `Write tool enabled for this request only: ${event.writeEnabled.server} / ${event.writeEnabled.tool}.`,
            });
          }
          break;
        case "text":
          updateItem(assistantId, (item) => ({ ...item, text: item.text + event.text }));
          break;
        case "thinking":
          addTrace({ kind: "thinking", id: nextId("thinking"), turn: turnNumber, text: event.text });
          break;
        case "tool_call":
          addTrace({
            kind: "tool",
            id: event.id,
            turn: turnNumber,
            server: event.server,
            name: event.name,
            input: event.input,
            status: "running",
          });
          break;
        case "tool_result":
          setTrace((current) =>
            current.map((entry) =>
              entry.kind === "tool" && entry.id === event.toolUseId
                ? { ...entry, status: event.isError ? "error" : "ok", result: event.text }
                : entry,
            ),
          );
          break;
        case "proposal":
          setProposals((current) => [...current, event.proposal]);
          addTrace({
            kind: "proposal",
            id: event.proposal.toolUseId,
            turn: turnNumber,
            tool: event.proposal.tool,
            server: event.proposal.server,
            status: "pending",
          });
          break;
        case "done":
          outcome.completed = true;
          transcript.current = [...transcript.current, ...event.newMessages];
          if (event.audit) addTrace({ kind: "audit", id: nextId("audit"), turn: turnNumber, audit: event.audit });
          addTrace({
            kind: "info",
            id: nextId("usage"),
            turn: turnNumber,
            text: `Turn ${turnNumber}: ${event.usage.inputTokens} in / ${event.usage.outputTokens} out tokens (${event.usage.cacheReadInputTokens} from cache).`,
          });
          if (event.stopReason === "refusal") addNote("The model declined this request.", "error");
          if (event.stopReason === "max_tokens") addNote("The reply hit the token limit and was cut short.", "error");
          break;
        case "error":
          addNote(event.message, "error");
          break;
      }
    };

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: transcript.current, ...payload }),
      });
      if (!response.ok || !response.body) {
        const problem = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
        if (response.status === 401) setSignedOut(true);
        addNote(problem?.message ?? `Request failed (${response.status}).`, "error");
      } else {
        await readNdjson<ChatStreamEvent>(response.body, handle);
      }
    } catch (error) {
      addNote(error instanceof Error ? error.message : "Network error.", "error");
    } finally {
      setItems((current) =>
        current
          .map((item) => (item.id === assistantId ? { ...item, streaming: false } : item))
          .filter((item) => item.id !== assistantId || item.text.trim().length > 0),
      );
      setBusy(false);
    }
    return outcome.completed;
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || busy || proposals.length > 0) return;
    setInput("");
    await send({ userText: text });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  async function decide(proposal: Proposal, approve: boolean) {
    const previous = proposals;
    setProposals([]);
    setTrace((current) =>
      current.map((entry) =>
        entry.kind === "proposal" && previous.some((item) => item.toolUseId === entry.id)
          ? { ...entry, status: entry.id === proposal.toolUseId && approve ? "approved" : "rejected" }
          : entry,
      ),
    );
    addNote(`${approve ? "Approved" : "Rejected"}: ${proposal.summary || proposal.tool}`);
    const completed = await send({ decision: { toolUseId: proposal.toolUseId, approve } });
    if (!completed) {
      // Nothing reached the transcript, so the proposal is still pending server-side: offer it again.
      setProposals(previous);
    }
  }

  const locked = busy || proposals.length > 0 || signedOut;

  return (
    <main className="workspace">
      <section className="chat" aria-label="Chat">
        <div className="messages" aria-live="polite">
          {items.length === 0 ? (
            <div className="empty">
              <h2>Ask about your org</h2>
              <p className="subtle">
                Reads run immediately as you. Creates and updates are proposed first and only run after you approve them.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} type="button" className="chip" disabled={locked} onClick={() => setInput(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            items.map((item) => (
              <div key={item.id} className={`message ${item.role}${item.tone ? ` ${item.tone}` : ""}`}>
                {item.role === "assistant" && item.streaming && !item.text ? (
                  <span className="typing" aria-label="Assistant is working">
                    Working
                  </span>
                ) : (
                  item.text
                )}
              </div>
            ))
          )}
          {proposals.map((proposal) => (
            <ProposalCard key={proposal.toolUseId} proposal={proposal} disabled={busy} onDecide={decide} />
          ))}
          {signedOut ? (
            <div className="message note error">
              Your Salesforce session ended. <a href="/api/auth/salesforce/login">Sign in again</a>.
            </div>
          ) : null}
          <div ref={bottom} />
        </div>

        <form className="composer" onSubmit={submit}>
          <label htmlFor="prompt" className="visually-hidden">
            Message
          </label>
          <textarea
            id="prompt"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={proposals.length > 0 ? "Approve or reject the proposed change first." : "Ask about accounts, pipeline, cases..."}
            rows={2}
            maxLength={4000}
            disabled={locked}
          />
          <button type="submit" className="btn primary" disabled={locked || !input.trim()}>
            {busy ? "Working" : "Send"}
          </button>
        </form>
      </section>

      <TracePanel entries={trace} servers={servers} model={model} />
    </main>
  );
}
