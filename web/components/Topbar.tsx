import Link from "next/link";
import type { SessionData } from "@/lib/session";

export interface SignedInUser {
  label: string;
  orgId?: string;
  instanceHost: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What the header shows about the session: never a token. */
export function signedInUser(session: SessionData): SignedInUser {
  return {
    label: session.user.username ?? session.user.userId ?? "Salesforce user",
    orgId: session.user.orgId,
    instanceHost: hostOf(session.tokens.instanceUrl),
  };
}

interface TopbarProps {
  user: SignedInUser | null;
  /** Current page, for the chat / brief switch shown to signed-in users. */
  active?: "chat" | "brief";
}

export default function Topbar({ user, active = "chat" }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">H360</span>
        <div>
          <h1>Headless 360 Assistant</h1>
          <p className="subtle">Claude + Salesforce Hosted MCP · runs as you</p>
        </div>
      </div>
      {user ? (
        <>
          <nav className="nav" aria-label="Workflows">
            <Link href="/" aria-current={active === "chat" ? "page" : undefined}>
              Chat
            </Link>
            <Link href="/brief" aria-current={active === "brief" ? "page" : undefined}>
              Meeting brief
            </Link>
          </nav>
          <div className="account">
            <div className="account-text">
              <span className="account-name">{user.label}</span>
              <span className="subtle mono-small">
                {user.instanceHost}
                {user.orgId ? ` · ${user.orgId}` : ""}
              </span>
            </div>
            <form action="/api/auth/salesforce/logout" method="post">
              <button type="submit" className="btn ghost">
                Sign out
              </button>
            </form>
          </div>
        </>
      ) : null}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      Built for Day 15 of 15 Days of Salesforce Headless 360 by Avnish Yadav ·{" "}
      <a href="https://avnishyadav.com" target="_blank" rel="noreferrer">
        avnishyadav.com
      </a>
    </footer>
  );
}
