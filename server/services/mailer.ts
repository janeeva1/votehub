import nodemailer from "nodemailer";
import { config } from "../config";
import { logger } from "../logger";

let transport: nodemailer.Transporter | null = null;
if (config.smtp.host) {
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

export const mailEnabled = () => transport !== null;

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Sends an email. Without SMTP configured the message is printed to the server log
 * (so development and first-run setups still work end to end).
 */
export async function sendMail(to: string, subject: string, lines: string[], action?: { label: string; url: string }) {
  const text = [...lines, action ? `\n${action.label}: ${action.url}` : ""].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2d2a;max-width:560px">
    ${lines.map((l) => `<p>${escape(l)}</p>`).join("")}
    ${action ? `<p><a href="${escape(action.url)}" style="display:inline-block;background:#286352;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${escape(action.label)}</a></p><p style="font-size:12px;color:#667">${escape(action.url)}</p>` : ""}
    <p style="font-size:12px;color:#889">— ${escape(config.appName)}</p></div>`;
  if (!transport) {
    logger.info(`[email not sent — SMTP not configured] To: ${to} | ${subject}\n${text}`);
    return { delivered: false };
  }
  await transport.sendMail({ from: config.smtp.from || config.smtp.user, to, subject, text, html });
  return { delivered: true };
}
