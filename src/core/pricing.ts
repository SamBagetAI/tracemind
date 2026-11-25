/**
 * What a session would cost at Claude API list prices, per million tokens. It is an estimate of
 * the API-price equivalent: on a Claude subscription nobody pays per token, and caching changes
 * the bill a lot, which is why cached input is counted at its own price.
 *
 * Prices from the Claude API model table (2026-11). Where a cache price is not listed, the
 * standard ratios apply: writing to the cache costs 1.25x input, reading from it 0.1x input.
 */
type Price = { input: number; output: number; cacheWrite?: number; cacheRead?: number };

const PRICES: [RegExp, Price][] = [
  [/fable-5-2|mythos-5-2/, { input: 8, output: 40, cacheRead: 0.2 }],
  [/fable-5-1|mythos-5-1|fable-5\b|mythos-5\b/, { input: 10, output: 50 }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-5\b|opus-4-[5-9]/, { input: 5, output: 25 }],
  [/opus-4/, { input: 15, output: 75 }],
  [/sonnet-5-5/, { input: 2, output: 10, cacheRead: 0.1 }],
  [/sonnet-5\b/, { input: 2, output: 10 }],
  [/sonnet/, { input: 3, output: 15 }],
  [/haiku-5-5/, { input: 0.1, output: 0.5 }],
  [/haiku-4/, { input: 1, output: 5 }],
  [/haiku/, { input: 0.8, output: 4 }],
];

export type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };

/** The cost in US dollars of one model response, or 0 for a model Tracemind has no price for. */
export function costOf(model: string | undefined, u: Usage): number {
  const p = model ? PRICES.find(([re]) => re.test(model))?.[1] : undefined;
  if (!p) return 0;
  const perM = (tokens: number | undefined, price: number) => ((tokens ?? 0) / 1e6) * price;
  return (
    perM(u.input_tokens, p.input) +
    perM(u.cache_creation_input_tokens, p.cacheWrite ?? p.input * 1.25) +
    perM(u.cache_read_input_tokens, p.cacheRead ?? p.input * 0.1) +
    perM(u.output_tokens, p.output)
  );
}

/**
 * Time someone was working with the agent: the gaps between steps, each counted up to 15 minutes.
 * A session left open overnight is not 17 hours of work.
 */
export const IDLE_MS = 15 * 60 * 1000;
export function activeMs(times: string[]): number {
  let total = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = Date.parse(times[i]) - Date.parse(times[i - 1]);
    if (gap > 0) total += Math.min(gap, IDLE_MS);
  }
  return total;
}
