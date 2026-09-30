import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Brief from "@/components/Brief";
import Topbar, { Footer, signedInUser } from "@/components/Topbar";
import { mcpServerInfo } from "@/lib/anthropic";
import { ConfigError, loadConfig, type AppConfig } from "@/lib/config";
import { readSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Meeting brief · Headless 360 Assistant",
};

function configOrNull(): AppConfig | null {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

/** Day 10 workflow: an Account name in, a read-only pre-meeting brief out. Setup and sign-in live on "/". */
export default async function BriefPage() {
  const config = configOrNull();
  const session = config ? readSession(await cookies(), config.sessionSecret) : null;
  if (!config || !session) redirect("/");

  return (
    <div className="shell">
      <Topbar user={signedInUser(session)} active="brief" />
      <Brief model={config.anthropic.model} servers={mcpServerInfo(config)} />
      <Footer />
    </div>
  );
}
