/**
 * Removes secrets and personal data from text before it is stored or sent.
 * Runs on the machine that parses a session and again on the server that receives it.
 */

const RULES: { name: string; pattern: RegExp }[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "stripe-key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  { name: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "aws-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "google-key", pattern: /\bAIza[A-Za-z0-9_-]{30,}/g },
  { name: "bearer", pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { name: "url-credentials", pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi },
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/** `KEY=value` or `"apiKey": "value"` where the name says it is a secret. */
const NAMED_SECRET =
  /\b([A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi;

const CARD = /\b(?:\d[ -]?){13,19}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export type Redacted = { text: string; count: number };

export function redactCounted(input: string): Redacted {
  let count = 0;
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match, ...groups) => {
      count++;
      if (rule.name === "bearer") return `${groups[0]} [redacted]`;
      if (rule.name === "url-credentials") return `${groups[0]}[redacted]@`;
      return `[redacted ${rule.name}]`;
    });
  }
  text = text.replace(NAMED_SECRET, (match, name: string, sep: string, value: string) => {
    if (value.startsWith("[redacted")) return match;
    count++;
    return `${name}${sep}[redacted]`;
  });
  text = text.replace(CARD, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return match;
    count++;
    return "[redacted card]";
  });
  return { text, count };
}

export function redact(input: string): string {
  return redactCounted(input).text;
}

/** Redacts and cuts text to `max` characters, saying how much was cut. */
export function clip(input: string, max: number): string {
  const text = redact(input);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} more characters]`;
}
