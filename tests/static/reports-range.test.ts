import { describe, it, expect } from "bun:test";
import { rangePhrase, resolveRange } from "../../plugins/reports-omp/lib/range";

// Wed 7 Oct 2026 14:30, local time.
const NOW = new Date(2026, 9, 7, 14, 30);
const at = (month: number, day: number, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute);

describe("reports RANGE resolution", () => {
  const cases: [spec: string, start: Date, end: Date][] = [
    // A..B includes A and excludes B, whatever kind of token B is.
    ["2026-09-28..2026-10-05", at(9, 28), at(10, 5)],
    ["mo-3..mo-1", at(7, 1), at(9, 1)],
    ["09:00..12:30", at(10, 7, 9), at(10, 7, 12, 30)],
    ["2026-09-14T09:30..2026-09-14T10:00", at(9, 14, 9, 30), at(9, 14, 10)],
    ["2026-10-05..", at(10, 5), NOW],
    // A single token covers its whole span.
    ["2026-09-14", at(9, 14), at(9, 15)],
    ["2026-09", at(9, 1), at(10, 1)],
    ["lw", at(9, 28), at(10, 5)],
    ["mtd", at(10, 1), NOW],
  ];
  for (const [spec, start, end] of cases) {
    it(`${spec} covers [${start.toISOString()}, ${end.toISOString()})`, () => {
      expect(resolveRange(spec, NOW, "mon")).toEqual({ start, end });
    });
  }

  it("rejects a range whose end is its start", () => {
    expect(() => resolveRange("2026-10-05..2026-10-05", NOW, "mon")).toThrow("empty");
  });
});

describe("reports range phrases", () => {
  it("names an exclusive end with until", () => {
    const spec = "2026-09-28..2026-10-05";
    expect(rangePhrase(spec, resolveRange(spec, NOW, "mon"), NOW)).toBe("From Mon 28 Sep 2026 until Mon 5 Oct 2026");
  });

  it("names a one-day range by its day", () => {
    const spec = "2026-10-05..2026-10-06";
    expect(rangePhrase(spec, resolveRange(spec, NOW, "mon"), NOW)).toBe("On Mon 5 Oct 2026");
  });
});
