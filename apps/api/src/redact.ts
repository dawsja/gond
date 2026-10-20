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

export function createRedactor(secrets: readonly (string | null | undefined)[], maxLength = MAX_LOG_LINE) {
  const known = secrets
    .filter((secret): secret is string => Boolean(secret) && (secret as string).length >= 8)
    .sort((a, b) => b.length - a.length);
  return (line: string) => {
    let out = line;
    for (const secret of known) out = out.split(secret).join("***");
    for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "***");
    return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
  };
}

export const redact = createRedactor([]);
