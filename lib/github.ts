import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

// ─── Token encryption (AES-256-GCM) ───────────────────────────────────────────
// The GitHub OAuth token is stored encrypted in the DB and never sent to the
// browser. The key accepts any length secret; it is normalized via SHA-256.
// Stored format: base64(iv 12B || authTag 16B || ciphertext).

function getKey(): Buffer {
  const secret = process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "GITHUB_TOKEN_ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32"
    );
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptToken(plain: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptToken(enc: string): string {
  const key = getKey();
  const buf = Buffer.from(enc, "base64");
  if (buf.length < 12 + 16 + 1) throw new Error("Malformed encrypted token");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// ─── Repo name validation (GitHub rules, simplified) ──────────────────────────

export function validateRepoName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Repository name is required.";
  if (trimmed.length > 100) return "Repository name must be 100 characters or fewer.";
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed))
    return "Use only letters, numbers, dots, hyphens and underscores.";
  if (trimmed.startsWith(".") || trimmed.endsWith("."))
    return "Repository name cannot start or end with a dot.";
  if (trimmed.includes("..")) return "Repository name cannot contain consecutive dots.";
  return null;
}

// ─── OAuth helpers ────────────────────────────────────────────────────────────

export const GITHUB_OAUTH_STATE_COOKIE = "github_oauth_state";
export const GITHUB_WORKSPACE_COOKIE = "github_workspace_id";

export function getGithubClientId(): string {
  const id = process.env.GITHUB_CLIENT_ID;
  if (!id) throw new Error("GITHUB_CLIENT_ID is not set. Create a GitHub OAuth App first.");
  return id;
}

export function getGithubRedirectUri(): string {
  const uri = process.env.GITHUB_REDIRECT_URI;
  if (!uri)
    throw new Error(
      "GITHUB_REDIRECT_URI is not set. It must match the callback URL in your GitHub OAuth App."
    );
  return uri;
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getGithubClientId(),
    redirect_uri: getGithubRedirectUri(),
    scope: "repo read:user",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export function newOAuthState(): string {
  return randomBytes(24).toString("hex");
}
