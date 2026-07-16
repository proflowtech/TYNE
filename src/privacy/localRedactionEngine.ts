import { scanSensitiveData } from './sensitiveDataScanner';

/**
 * Replace sensitive values with typed placeholders.
 * Original values never leave this function's return path.
 */
export function redactSensitiveText(text: string): { text: string; redacted: boolean; count: number } {
  if (!text) return { text: '', redacted: false, count: 0 };
  const matches = scanSensitiveData(text);
  if (!matches.length) return { text, redacted: false, count: 0 };

  // Apply from end so offsets stay valid
  let next = text;
  let count = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    // Skip overlapping earlier ranges
    if (i > 0 && matches[i - 1].end > m.start) continue;
    next = next.slice(0, m.start) + m.placeholder + next.slice(m.end);
    count++;
  }
  return { text: next, redacted: count > 0, count };
}

export function redactObjectStrings<T>(value: T, depth = 0): T {
  if (depth > 8 || value == null) return value;
  if (typeof value === 'string') return redactSensitiveText(value).text as T;
  if (Array.isArray(value)) return value.map(item => redactObjectStrings(item, depth + 1)) as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactObjectStrings(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
