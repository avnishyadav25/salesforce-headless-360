/**
 * Server-side configuration, read from environment variables on every request.
 * Nothing in here is ever sent to the browser.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface AppConfig {
  salesforce: {
    /** Authorization server base URL (login, test, or My Domain). No trailing slash. */
    loginUrl: string;
    clientId: string;
    clientSecret?: string;
    callbackUrl: string;
    scopes: string;
    /** Optional RFC 8707 resource indicators sent on authorize/token requests. */
    resources: string[];
    tokenMaxAgeSeconds: number;
  };
  mcp: {
    sobjectUrl: string;
    customUrl?: string;
    sobjectWriteTools: string[];
    customWriteTools: string[];
  };
  anthropic: {
    apiKey: string;
    model: string;
    mcpBeta: string;
    maxTokens: number;
    effort?: Effort;
  };
  sessionSecret: string;
  /** Mark cookies Secure when the app itself is served over https. */
  secureCookies: boolean;
}

export type EnvSource = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuration problem: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

export const DEFAULTS = {
  loginUrl: "https://login.salesforce.com",
  callbackUrl: "http://localhost:3000/api/auth/salesforce/callback",
  scopes: "mcp_api refresh_token",
  tokenMaxAgeSeconds: 900,
  sobjectUrl: "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
  sobjectWriteTools: "createSobjectRecord,updateSobjectRecord,updateRelatedRecord,deleteSobjectRecord",
  customWriteTools: "createFollowUpTask",
  model: "claude-sonnet-5-5",
  mcpBeta: "mcp-client-2025-11-20",
  maxTokens: 16000,
} as const;

function read(env: EnvSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isLocalhost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function checkUrl(
  problems: string[],
  name: string,
  value: string,
  { allowLocalHttp = false }: { allowLocalHttp?: boolean } = {},
): string {
  try {
    const url = new URL(value);
    const httpOk = allowLocalHttp && url.protocol === "http:" && isLocalhost(url);
    if (url.protocol !== "https:" && !httpOk) {
      problems.push(`${name} must be an https:// URL${allowLocalHttp ? " (http is allowed for localhost)" : ""}`);
    }
  } catch {
    problems.push(`${name} is not a valid URL`);
  }
  return value.replace(/\/+$/, "");
}

function positiveInt(problems: string[], name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    problems.push(`${name} must be a positive integer`);
    return fallback;
  }
  return parsed;
}

export function loadConfig(env: EnvSource = process.env): AppConfig {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = read(env, name);
    if (!value) problems.push(`${name} is not set`);
    return value ?? "";
  };

  const clientId = required("SF_CLIENT_ID");
  const apiKey = required("ANTHROPIC_API_KEY");
  const sessionSecret = required("SESSION_SECRET");
  if (sessionSecret && sessionSecret.length < 32) {
    problems.push("SESSION_SECRET must be at least 32 characters");
  }

  const loginUrl = checkUrl(problems, "SF_LOGIN_URL", read(env, "SF_LOGIN_URL") ?? DEFAULTS.loginUrl);
  const callbackUrl = checkUrl(problems, "SF_CALLBACK_URL", read(env, "SF_CALLBACK_URL") ?? DEFAULTS.callbackUrl, {
    allowLocalHttp: true,
  });
  const sobjectUrl = checkUrl(problems, "SF_MCP_SOBJECT_URL", read(env, "SF_MCP_SOBJECT_URL") ?? DEFAULTS.sobjectUrl);
  const customRaw = read(env, "SF_MCP_CUSTOM_URL");
  const customUrl = customRaw ? checkUrl(problems, "SF_MCP_CUSTOM_URL", customRaw) : undefined;

  const resources = list(read(env, "SF_OAUTH_RESOURCE") ?? "");
  resources.forEach((resource) => checkUrl(problems, "SF_OAUTH_RESOURCE", resource));

  const effortRaw = read(env, "ANTHROPIC_EFFORT");
  let effort: Effort | undefined;
  if (effortRaw) {
    if ((EFFORTS as readonly string[]).includes(effortRaw)) {
      effort = effortRaw as Effort;
    } else {
      problems.push(`ANTHROPIC_EFFORT must be one of ${EFFORTS.join(", ")}`);
    }
  }

  const tokenMaxAgeSeconds = positiveInt(
    problems,
    "SF_TOKEN_MAX_AGE_SECONDS",
    read(env, "SF_TOKEN_MAX_AGE_SECONDS"),
    DEFAULTS.tokenMaxAgeSeconds,
  );
  const maxTokens = positiveInt(problems, "ANTHROPIC_MAX_TOKENS", read(env, "ANTHROPIC_MAX_TOKENS"), DEFAULTS.maxTokens);

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    salesforce: {
      loginUrl,
      clientId,
      clientSecret: read(env, "SF_CLIENT_SECRET"),
      callbackUrl,
      scopes: read(env, "SF_SCOPES") ?? DEFAULTS.scopes,
      resources,
      tokenMaxAgeSeconds,
    },
    mcp: {
      sobjectUrl,
      customUrl,
      sobjectWriteTools: list(read(env, "SF_MCP_SOBJECT_WRITE_TOOLS") ?? DEFAULTS.sobjectWriteTools),
      customWriteTools: list(read(env, "SF_MCP_CUSTOM_WRITE_TOOLS") ?? DEFAULTS.customWriteTools),
    },
    anthropic: {
      apiKey,
      model: read(env, "ANTHROPIC_MODEL") ?? DEFAULTS.model,
      mcpBeta: read(env, "ANTHROPIC_MCP_BETA") ?? DEFAULTS.mcpBeta,
      maxTokens,
      effort,
    },
    sessionSecret,
    secureCookies: callbackUrl.startsWith("https://"),
  };
}
