const sensitiveKey = /(authorization|cookie|api[-_]?key|token|secret|password|session)/i;

function redactString(value: string) {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|api[-_]?key|secret|password|session)=([^\s,;&]+)/gi, '$1=[REDACTED]');
}

export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry)) as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = sensitiveKey.test(key) ? '[REDACTED]' : redactSecrets(entry);
    }
    return output as T;
  }
  return value;
}
