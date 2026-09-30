"use client";

import type { Proposal } from "@/lib/chat-types";

interface ProposalCardProps {
  proposal: Proposal;
  disabled: boolean;
  onDecide: (proposal: Proposal, approve: boolean) => void;
}

/** The confirmation step: nothing is written to Salesforce until the user clicks Approve. */
export default function ProposalCard({ proposal, disabled, onDecide }: ProposalCardProps) {
  return (
    <section className="proposal" aria-label="Proposed change">
      <header className="proposal-head">
        <span className="pill accent">Approval needed</span>
        <span className="mono-small subtle">
          {proposal.server} / {proposal.tool}
        </span>
      </header>
      <p className="proposal-summary">{proposal.summary || "The assistant wants to change data."}</p>
      <pre className="code">{JSON.stringify(proposal.arguments, null, 2)}</pre>
      {proposal.problem ? (
        <p className="alert" role="alert">
          {proposal.problem} Approving sends it back to the assistant instead of running it.
        </p>
      ) : null}
      <div className="proposal-actions">
        <button type="button" className="btn primary" disabled={disabled} onClick={() => onDecide(proposal, true)}>
          Approve
        </button>
        <button type="button" className="btn ghost" disabled={disabled} onClick={() => onDecide(proposal, false)}>
          Reject
        </button>
      </div>
    </section>
  );
}
