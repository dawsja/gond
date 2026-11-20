export const MAX_LOG_LINE = 4_000;

const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bxai-[A-Za-z0-9]{16,}\b/g,
  /\bak_[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abp]-[A-Za-z0-9-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const LONG_SECRET = 8;

// Characters that draw nothing: a value split by them still reads as itself on a page or a screen.
const INVISIBLE = /[\p{Cf}\u115f\u1160\u3164\uffa0]/gu;
const HAS_INVISIBLE = /[\p{Cf}\u115f\u1160\u3164\uffa0]/u;

/**
 * `short` also hides values from that length up to `LONG_SECRET`, as whole tokens only, so a
 * four-digit PIN never blanks part of a longer number. Off by default: a short value matches
 * ordinary words too often for every log line and reply.
 */
export function createRedactor(secrets: readonly (string | null | undefined)[], maxLength = MAX_LOG_LINE, options: { short?: number } = {}) {
  const values = secrets.filter((secret): secret is string => Boolean(secret)).sort((a, b) => b.length - a.length);
  const known = values.filter((secret) => secret.length >= LONG_SECRET);
  const floor = options.short;
  const short = floor === undefined ? [] : values.filter((secret) => secret.length >= floor && secret.length < LONG_SECRET).map((secret) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(secret)}(?![\\p{L}\\p{N}])`, "gu"));
  const hide = (text: string) => {
    let out = text;
    for (const secret of known) out = out.split(secret).join("***");
    for (const pattern of short) out = out.replace(pattern, "***");
    for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "***");
    return out;
  };
  return (line: string) => {
    let out = hide(line);
    // A value with invisible characters between its digits is read once more without them; the text
    // keeps them otherwise, since an emoji is built with them too.
    if (HAS_INVISIBLE.test(out)) {
      const bare = out.replace(INVISIBLE, "");
      const hidden = hide(bare);
      if (hidden !== bare) out = hidden;
    }
    return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
  };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
