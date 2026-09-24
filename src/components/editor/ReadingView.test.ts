import { describe, expect, it } from "vitest";
import { isMarkdownTableDelimiterRow } from "../../utils/markdownTable";

describe("AI chat table Markdown", () => {
    it("recognizes an indented delimiter row", () => {
        expect(isMarkdownTableDelimiterRow("    | --- | --- | --- |")).toBe(true);
    });

    it("rejects a non-table line with dashes", () => {
        expect(isMarkdownTableDelimiterRow("    --- plain text")).toBe(false);
    });
});
