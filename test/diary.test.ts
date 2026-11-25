import { describe, expect, it } from "vitest";
import { activeMs, costOf } from "../src/core/pricing.ts";
import { activeLabel, byDay, dayLabel, dollars, sentence, tokens } from "../web/src/lib/diary";

describe("diary sentences", () => {
  it("says a clean session ran clean", () => {
    expect(sentence({ toolErrors: 0, issues: [] })).toEqual([{ text: "Ran clean." }]);
  });

  it("names the first two issues and counts the rest", () => {
    const issues = ["A", "B", "C", "D"].map((what, i) => ({ what, seq: i + 1, key: `k${i}` }));
    const parts = sentence({ toolErrors: 26, issues });
    expect(parts[0]).toEqual({ text: "26 failed calls: " });
    expect(parts.filter((p) => "mark" in p).map((p) => ("mark" in p ? p.mark : ""))).toEqual(["A", "B"]);
    expect(parts[parts.length - 1]).toEqual({ text: " and 2 more." });
  });

  it("joins two issues with and, and handles one failure", () => {
    const two = sentence({ toolErrors: 2, issues: [{ what: "A", seq: 1, key: "a" }, { what: "B", seq: 2, key: "b" }] });
    expect(two.map((p) => ("text" in p ? p.text : `[${p.mark}]`)).join("")).toBe("2 failed calls: [A] and [B].");
    expect(sentence({ toolErrors: 1, issues: [] })).toEqual([{ text: "1 failed call." }]);
  });

  it("formats time, days, tokens and money", () => {
    expect(activeLabel(0)).toBe("under a minute");
    expect(activeLabel(22 * 60000)).toBe("22 min");
    expect(activeLabel(295 * 60000)).toBe("4 h 55");
    const now = new Date("2026-11-25T12:00:00Z");
    expect(dayLabel("2026-11-25", now)).toBe("Today");
    expect(dayLabel("2026-11-24", now)).toBe("Yesterday");
    expect(dayLabel("2026-11-23", now)).toBe("Mon 23");
    expect(dayLabel("2026-10-30", now)).toBe("Fri 30 Oct");
    expect(tokens(1_450_830)).toBe("1.5M");
    expect(tokens(21_441)).toBe("21k");
    expect(dollars(152.03)).toBe("$152");
    expect(dollars(0.79)).toBe("$0.79");
  });

  it("groups sessions by the day they started, newest first", () => {
    const g = byDay([{ startedAt: "2026-11-23T08:05:00Z" }, { startedAt: "2026-11-24T13:01:00Z" }, { startedAt: "2026-11-24T12:41:00Z" }]);
    expect(g.map((d) => d.day)).toEqual(["2026-11-24", "2026-11-23"]);
    expect(g[0].sessions[0].startedAt).toBe("2026-11-24T13:01:00Z");
  });
});

describe("active time and cost", () => {
  it("counts gaps up to 15 minutes, so an idle night is not work", () => {
    expect(activeMs(["2026-11-24T10:00:00Z", "2026-11-24T10:05:00Z", "2026-11-25T09:00:00Z", "2026-11-25T09:01:00Z"])).toBe((5 + 15 + 1) * 60000);
  });

  it("prices cached input at its own rate, and unknown models at nothing", () => {
    // Opus 5.5: $4 in, $20 out, cache reads $0.20, cache writes 1.25 x input.
    const c = costOf("claude-opus-5-5", { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 });
    expect(c).toBeCloseTo(4 + 20 + 0.2 + 5);
    expect(costOf("claude-haiku-5-5", { input_tokens: 1e6, cache_read_input_tokens: 1e6 })).toBeCloseTo(0.1 + 0.01);
    expect(costOf("some-other-model", { input_tokens: 1e6 })).toBe(0);
  });
});
