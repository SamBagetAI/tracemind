/**
 * Grey text stays readable. The two greys the UI writes in (muted and faint) keep at least 4.5:1
 * against every background they sit on, in both sets of tokens: the least contrast small text
 * should have (WCAG AA). Checked from the tokens in web/src/index.css.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("web/src/index.css", "utf8");

/** The color tokens of one block (":root" or ".dark"), by name. */
function tokens(selector: string): Record<string, string> {
  const block = new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const linear = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(n >> 16) + 0.7152 * linear((n >> 8) & 255) + 0.0722 * linear(n & 255);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Where grey text sits: the page, code panes, chips, hovered and open rows, menus. */
const BACKGROUNDS = ["--background", "--pane", "--muted", "--accent", "--popover"];

describe.each([":root", ".dark"])("grey text in %s", (selector) => {
  const t = tokens(selector);

  it("finds the tokens", () => {
    for (const name of ["--muted-foreground", "--faint", ...BACKGROUNDS]) expect(t[name], name).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it.each(["--muted-foreground", "--faint"])("%s reads on every background it sits on", (text) => {
    for (const bg of BACKGROUNDS) expect(contrast(t[text], t[bg]), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
});
