/* Minimal structured logger (no worker threads, works the same on Windows/Linux). */
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

function write(level: Level, msg: string, extra?: unknown) {
  if (order[level] < min) return;
  const time = new Date().toISOString();
  const line = `[${time}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) out(line);
  else if (extra instanceof Error) out(line, extra.stack ?? extra.message);
  else out(line, typeof extra === "string" ? extra : JSON.stringify(extra));
}

export const logger = {
  debug: (m: string, e?: unknown) => write("debug", m, e),
  info: (m: string, e?: unknown) => write("info", m, e),
  warn: (m: string, e?: unknown) => write("warn", m, e),
  error: (m: string, e?: unknown) => write("error", m, e),
};
