import crypto from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export const hmac = (value: string) => crypto.createHmac("sha256", config.secret).update(value).digest("hex");

/** Human-friendly codes without ambiguous characters (no 0/O, 1/I/L). */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function humanCode(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}
export const numericCode = (digits = 6) =>
  String(crypto.randomInt(0, 10 ** digits)).padStart(digits, "0");

// ---- Encryption at rest for payment-provider secrets (AES-256-GCM) ----
const encKey = crypto.createHash("sha256").update(`enc:${config.secret}`).digest();

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

export function decrypt(value: string): string {
  const [v, ivB64, tagB64, dataB64] = value.split(":");
  if (v !== "v1" || !ivB64 || !tagB64 || !dataB64) throw new Error("Unsupported ciphertext");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

// ---- Signed short-lived tokens (voter sessions) ----
export function signToken(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  return `${body}.${hmac(body)}`;
}

export function verifyToken<T = Record<string, unknown>>(token: string | undefined | null): (T & { exp: number }) | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = hmac(body);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}
