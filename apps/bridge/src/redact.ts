const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*\b/gi,
]

export function redactText(value: string, knownSecrets: readonly string[] = []): string {
  let redacted = value
  for (const secret of knownSecrets) {
    if (secret.length >= 8) redacted = redacted.replaceAll(secret, "[REDACTED]")
  }
  for (const pattern of secretPatterns) redacted = redacted.replace(pattern, "[REDACTED]")
  return redacted
}
