import { cookies } from "next/headers";
import Chat from "@/components/Chat";
import Topbar, { Footer, signedInUser, type SignedInUser } from "@/components/Topbar";
import { mcpServerInfo } from "@/lib/anthropic";
import type { McpServerInfo } from "@/lib/chat-types";
import { ConfigError, loadConfig } from "@/lib/config";
import { readSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const AUTH_ERRORS: Record<string, string> = {
  config: "The app is not configured yet.",
  invalid_state: "The sign-in response did not match this browser's login attempt. Start again.",
  access_denied: "Sign-in was cancelled, or this user is not allowed to use the External Client App.",
  invalid_grant: "Salesforce rejected the authorization code. Check the callback URL and PKCE settings, then retry.",
  invalid_client_id: "Salesforce does not recognize SF_CLIENT_ID. New External Client Apps can take up to 30 minutes to activate.",
  invalid_client: "Salesforce rejected the client credentials. Check SF_CLIENT_ID and SF_CLIENT_SECRET.",
  redirect_uri_mismatch: "SF_CALLBACK_URL does not match a callback URL on the External Client App.",
  token_exchange: "Salesforce did not return tokens. Check the server log.",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const authError = typeof params.auth_error === "string" ? params.auth_error : undefined;

  let problems: string[] = [];
  let user: SignedInUser | null = null;
  let model = "";
  let servers: McpServerInfo[] = [];

  try {
    const config = loadConfig();
    model = config.anthropic.model;
    servers = mcpServerInfo(config);
    const session = readSession(await cookies(), config.sessionSecret);
    if (session) user = signedInUser(session);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems = error.problems;
  }

  return (
    <div className="shell">
      <Topbar user={user} active="chat" />

      {problems.length > 0 ? (
        <main className="center">
          <section className="card">
            <h2>Finish setup</h2>
            <p>
              Copy <code>web/.env.example</code> to <code>web/.env.local</code>, fill it in, and restart{" "}
              <code>npm run dev</code>.
            </p>
            <ul className="problems">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </section>
        </main>
      ) : user ? (
        <Chat model={model} servers={servers} />
      ) : (
        <main className="center">
          <section className="card">
            <h2>Sign in to your org</h2>
            <p>
              The assistant calls Salesforce as you, through the hosted MCP servers below. Your object permissions,
              field-level security and sharing rules apply to every tool call, and nothing changes in the org until you
              approve it.
            </p>
            {authError ? (
              <p className="alert" role="alert">
                {AUTH_ERRORS[authError] ?? `Sign-in failed: ${authError}`}
              </p>
            ) : null}
            <a className="btn primary" href="/api/auth/salesforce/login">
              Sign in with Salesforce
            </a>
            <dl className="facts">
              <div className="fact-row">
                <dt>Model</dt>
                <dd className="mono-small">{model}</dd>
              </div>
              {servers.map((server) => (
                <div key={server.name} className="fact-row">
                  <dt>{server.label}</dt>
                  <dd className="mono-small">{server.url}</dd>
                </div>
              ))}
            </dl>
          </section>
        </main>
      )}

      <Footer />
    </div>
  );
}
