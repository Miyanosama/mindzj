import { describe, expect, it } from "vitest";
import { createHighlightRegex, createItalicRegex } from "./markdownInline";

function matches(regex: RegExp, text: string): string[] {
    return [...text.matchAll(regex)].map((match) => match[1] ?? match[0]);
}

describe("inline Markdown delimiter detection", () => {
    it("does not treat numeric multiplication as italic text", () => {
        const text = "24w/人/年*2 + 5%强积金+ 租实体办公室（“*2 + 5%强积金+ 租实体办公室”";
        expect(matches(createItalicRegex(), text)).toEqual([]);
    });

    it("keeps escaped asterisks literal", () => {
        expect(matches(createItalicRegex(), String.raw`价格\*2 与 \*3`)).toEqual([]);
    });

    it("still recognizes intentional italic text", () => {
        expect(matches(createItalicRegex(), "这是 *重点* 内容")).toEqual(["重点"]);
    });

    it("recognizes percent-delimited highlights", () => {
        expect(matches(createHighlightRegex(), "这是 %%高亮%% 内容")).toEqual([
            "高亮",
        ]);
    });

    it("does not recognize legacy, escaped, or triple-percent markers", () => {
        expect(matches(createHighlightRegex(), "==旧高亮==")).toEqual([]);
        expect(matches(createHighlightRegex(), String.raw`\%%普通文字%%`)).toEqual(
            [],
        );
        expect(matches(createHighlightRegex(), "%%%普通文字%%%")).toEqual([]);
    });
});
