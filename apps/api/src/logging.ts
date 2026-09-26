const sensitiveKey =
  /authorization|cookie|credential|secret|token|note|raw.?content|prompt|private.?path/i;

export function redactForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactForLog(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      sensitiveKey.test(key) ? '[REDACTED]' : redactForLog(entry),
    ]),
  );
}

export const loggerOptions = {
  level: process.env.MAESTRO_LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'request.headers.authorization',
      'request.headers.cookie',
      '*.note',
      '*.rawContent',
      '*.credential',
      '*.prompt',
    ] as string[],
    censor: '[REDACTED]',
  },
};
