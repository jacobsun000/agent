import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { CONFIG_PATH } from "@/utils/utils";

const AUTH_FILE_PATH = path.join(CONFIG_PATH, "auth.json");

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_SCOPE = "openid profile email offline_access";
const CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_AUTH_PROVIDER_KEYS = ["codex", "openai-codex"] as const;

type AuthFileData = Record<string, unknown>;

export type CodexOAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

export type CodexAuthSession = {
  accessToken: string;
  accountId: string;
};

export type CodexAuthorizationFlow = {
  url: string;
  state: string;
  verifier: string;
};

type ParsedAuthorizationInput = {
  code?: string;
  state?: string;
};

function isCodexOAuthCredential(value: unknown): value is CodexOAuthCredential {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "oauth" &&
    typeof candidate.access === "string" &&
    typeof candidate.refresh === "string" &&
    typeof candidate.expires === "number" &&
    Number.isFinite(candidate.expires) &&
    typeof candidate.accountId === "string" &&
    candidate.accountId.trim() !== ""
  );
}

async function readAuthFile(): Promise<AuthFileData> {
  try {
    const raw = await readFile(AUTH_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed as AuthFileData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeAuthFile(data: AuthFileData): Promise<void> {
  await mkdir(path.dirname(AUTH_FILE_PATH), { recursive: true, mode: 0o700 });
  await writeFile(AUTH_FILE_PATH, JSON.stringify(data, null, 2), "utf8");
  await chmod(AUTH_FILE_PATH, 0o600);
}

function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const payload = parts[1];
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const authClaims = payload?.[CODEX_JWT_CLAIM_PATH];
  if (!authClaims || typeof authClaims !== "object" || Array.isArray(authClaims)) {
    return null;
  }

  const accountId = (authClaims as Record<string, unknown>).chatgpt_account_id;
  if (typeof accountId !== "string" || accountId.trim() === "") {
    return null;
  }

  return accountId;
}

function normalizeCodexCredential(value: unknown): CodexOAuthCredential | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "oauth") {
    return null;
  }

  if (
    typeof candidate.access !== "string" ||
    typeof candidate.refresh !== "string" ||
    typeof candidate.expires !== "number" ||
    !Number.isFinite(candidate.expires)
  ) {
    return null;
  }

  const accountId = typeof candidate.accountId === "string" && candidate.accountId.trim() !== ""
    ? candidate.accountId
    : extractAccountId(candidate.access);
  if (!accountId) {
    return null;
  }

  return {
    type: "oauth",
    access: candidate.access,
    refresh: candidate.refresh,
    expires: candidate.expires,
    accountId
  };
}

async function getStoredCodexCredential(): Promise<CodexOAuthCredential | null> {
  const authData = await readAuthFile();

  for (const providerKey of CODEX_AUTH_PROVIDER_KEYS) {
    const normalized = normalizeCodexCredential(authData[providerKey]);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

async function refreshCodexCredential(credential: CodexOAuthCredential): Promise<CodexOAuthCredential> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: CODEX_CLIENT_ID
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Codex token refresh failed (${response.status}): ${text}`);
  }

  const payload = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (
    typeof payload.access_token !== "string" ||
    typeof payload.refresh_token !== "string" ||
    typeof payload.expires_in !== "number"
  ) {
    throw new Error("Codex token refresh failed: invalid token response.");
  }

  const accountId = extractAccountId(payload.access_token);
  if (!accountId) {
    throw new Error("Codex token refresh failed: missing account id.");
  }

  return {
    type: "oauth",
    access: payload.access_token,
    refresh: payload.refresh_token,
    expires: Date.now() + (payload.expires_in * 1000),
    accountId
  };
}

export async function saveCodexCredential(credential: CodexOAuthCredential): Promise<void> {
  const authData = await readAuthFile();
  authData.codex = credential;
  await writeAuthFile(authData);
}

export async function getCodexAuthSession(): Promise<CodexAuthSession> {
  const storedCredential = await getStoredCodexCredential();
  if (!storedCredential) {
    throw new Error(
      `Missing Codex OAuth credential in ${AUTH_FILE_PATH}. Run 'agent auth codex' first.`
    );
  }

  const refreshLeewayMs = 30_000;
  const credential = storedCredential.expires <= Date.now() + refreshLeewayMs
    ? await refreshCodexCredential(storedCredential)
    : storedCredential;

  if (!isCodexOAuthCredential(storedCredential) || credential.expires !== storedCredential.expires) {
    await saveCodexCredential(credential);
  }

  return {
    accessToken: credential.access,
    accountId: credential.accountId
  };
}

function toBase64Url(value: Buffer): string {
  return value.toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function createCodeVerifier(): string {
  return toBase64Url(randomBytes(32));
}

function createCodeChallenge(verifier: string): string {
  return toBase64Url(createHash("sha256").update(verifier).digest());
}

function createState(): string {
  return randomBytes(16).toString("hex");
}

export function parseCodexAuthorizationInput(input: string): ParsedAuthorizationInput {
  const value = input.trim();
  if (value === "") {
    return {};
  }

  try {
    const parsed = new URL(value);
    return {
      code: parsed.searchParams.get("code") ?? undefined,
      state: parsed.searchParams.get("state") ?? undefined
    };
  } catch {
    // continue
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return {
      code: code || undefined,
      state: state || undefined
    };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined
    };
  }

  return { code: value };
}

export async function createCodexAuthorizationFlow(originator = "agent"): Promise<CodexAuthorizationFlow> {
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = createState();

  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", CODEX_REDIRECT_URI);
  url.searchParams.set("scope", CODEX_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);

  return {
    url: url.toString(),
    state,
    verifier
  };
}

export async function exchangeCodexAuthorizationCode(
  code: string,
  verifier: string
): Promise<CodexOAuthCredential> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: CODEX_REDIRECT_URI
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Codex token exchange failed (${response.status}): ${text}`);
  }

  const payload = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (
    typeof payload.access_token !== "string" ||
    typeof payload.refresh_token !== "string" ||
    typeof payload.expires_in !== "number"
  ) {
    throw new Error("Codex token exchange failed: invalid token response.");
  }

  const accountId = extractAccountId(payload.access_token);
  if (!accountId) {
    throw new Error("Codex token exchange failed: missing account id.");
  }

  return {
    type: "oauth",
    access: payload.access_token,
    refresh: payload.refresh_token,
    expires: Date.now() + (payload.expires_in * 1000),
    accountId
  };
}
