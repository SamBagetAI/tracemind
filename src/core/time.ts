/** Days as milliseconds, and where a window of N days starts. Shared by the server, the CLI and the web UI. */
export const DAY = 86_400_000;

/** The ISO time `days` days before `from` (now by default): where a window of that many days starts. */
export const daysAgo = (days: number, from = Date.now()) => new Date(from - days * DAY).toISOString();
