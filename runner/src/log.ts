// Minimal structured stderr logger. Never logs secrets.
function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info(msg: string, extra?: Record<string, unknown>) {
    process.stderr.write(`${ts()} INFO  ${msg}${fmt(extra)}\n`);
  },
  warn(msg: string, extra?: Record<string, unknown>) {
    process.stderr.write(`${ts()} WARN  ${msg}${fmt(extra)}\n`);
  },
  error(msg: string, extra?: Record<string, unknown>) {
    process.stderr.write(`${ts()} ERROR ${msg}${fmt(extra)}\n`);
  },
};

function fmt(extra?: Record<string, unknown>): string {
  if (!extra || Object.keys(extra).length === 0) return "";
  try {
    return " " + JSON.stringify(extra);
  } catch {
    return " [unserializable]";
  }
}
