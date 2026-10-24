import { logger } from "../logger";

/**
 * SMS through Termii (https://termii.com) — widely used in Nigeria and across Africa.
 * Configure TERMII_API_KEY and TERMII_SENDER_ID (an approved sender ID). Without them, messages are logged.
 */
const apiKey = process.env.TERMII_API_KEY?.trim() || "";
const senderId = process.env.TERMII_SENDER_ID?.trim() || "";
const channel = process.env.TERMII_CHANNEL?.trim() || "generic";
const baseUrl = (process.env.TERMII_BASE_URL?.trim() || "https://api.ng.termii.com").replace(/\/$/, "");

export const smsEnabled = () => Boolean(apiKey && senderId);

/** Normalizes Nigerian-style numbers (0803… → 234803…); other numbers keep their country code. */
export function normalizePhone(raw: string): string | null {
  let n = raw.replace(/[^\d+]/g, "");
  if (n.startsWith("+")) n = n.slice(1);
  else if (n.startsWith("0") && n.length === 11) n = `234${n.slice(1)}`;
  return /^\d{10,15}$/.test(n) ? n : null;
}

export async function sendSms(to: string, text: string): Promise<{ delivered: boolean }> {
  const phone = normalizePhone(to);
  if (!phone) return { delivered: false };
  if (!smsEnabled()) {
    logger.info(`[sms not sent — Termii not configured] To: ${phone} | ${text}`);
    return { delivered: false };
  }
  try {
    const res = await fetch(`${baseUrl}/api/sms/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: phone, from: senderId, sms: text.slice(0, 480), type: "plain", channel, api_key: apiKey }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      logger.warn(`Termii SMS to ${phone} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return { delivered: false };
    }
    return { delivered: true };
  } catch (err) {
    logger.warn(`Termii SMS to ${phone} failed: ${(err as Error).message}`);
    return { delivered: false };
  }
}

/** A wa.me link that opens WhatsApp with a ready-made message (free, no API needed). */
export function whatsappLink(phone: string | null | undefined, text: string): string | null {
  const n = phone ? normalizePhone(phone) : null;
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}
