import { describe, expect, it } from "vitest";
import { fmtTokens } from "./ActivityPanel";

describe("fmtTokens", () => {
  it("rounds token counts for the activity log", () => {
    expect(fmtTokens(840)).toBe("840");
    expect(fmtTokens(1000)).toBe("1k");
    expect(fmtTokens(8234)).toBe("8.2k");
    expect(fmtTokens(12_345)).toBe("12k");
  });
});
