import "server-only";

import { createHmac, timingSafeEqual } from "crypto";

export const LOCAL_AUTH_COOKIE_NAME = "avorofin_local_auth";
export const LOCAL_AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function getLocalAuthSecret() {
  return process.env.LOCAL_AUTH_SECRET || "";
}

function getLocalAuthEmail() {
  return process.env.LOCAL_AUTH_EMAIL || "";
}

function getLocalAuthPassword() {
  return process.env.LOCAL_AUTH_PASSWORD || "";
}

function toBase64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function signPayload(payload: string) {
  const secret = getLocalAuthSecret();

  if (!secret) {
    throw new Error("LOCAL_AUTH_SECRET is not set");
  }

  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}

export function isLocalAuthConfigured() {
  return Boolean(getLocalAuthEmail() && getLocalAuthPassword() && getLocalAuthSecret());
}

export function validateLocalAuthCredentials(email: string, password: string) {
  if (!isLocalAuthConfigured()) return false;

  return (
    safeEqual(email.trim().toLowerCase(), getLocalAuthEmail().trim().toLowerCase()) &&
    safeEqual(password, getLocalAuthPassword())
  );
}

export function createLocalAuthToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = toBase64Url(
    JSON.stringify({
      v: 1,
      iat: now,
      exp: now + LOCAL_AUTH_MAX_AGE_SECONDS,
    })
  );

  return `${payload}.${signPayload(payload)}`;
}

export function verifyLocalAuthToken(token?: string | null) {
  if (!token || !isLocalAuthConfigured()) return false;

  const [payload, signature] = token.split(".");

  if (!payload || !signature) return false;

  const expectedSignature = signPayload(payload);

  if (!safeEqual(signature, expectedSignature)) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const exp = Number(data.exp || 0);

    return exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function getSafeNextPath(value: unknown) {
  const next = String(value || "/");

  if (!next.startsWith("/") || next.startsWith("/login") || next.startsWith("//")) {
    return "/";
  }

  return next;
}
