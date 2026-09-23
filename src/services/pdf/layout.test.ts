import { describe, expect, it } from "vitest";
import { analyzePdfTextItems, type PdfTextItemInput } from "./layout";

const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;

function item(text: string, x: number, top: number, width = 220, size = 10): PdfTextItemInput {
    return {
        str: text,
        transform: [size, 0, 0, size, x, PAGE_HEIGHT - top - size],
        width,
        height: size,
        fontName: "Body",
        hasEOL: true,
    };
}

describe("analyzePdfTextItems", () => {
    it("restores two-column reading order", () => {
        const analysis = analyzePdfTextItems(1, PAGE_WIDTH, PAGE_HEIGHT, [
            item("Paper title", 80, 30, 440, 18),
            item("Left first line continues", 45, 100),
            item("Left paragraph ends.", 45, 114, 150),
            item("Left second paragraph.", 45, 142, 160),
            item("Right first paragraph.", 330, 100, 180),
            item("Right second paragraph.", 330, 130, 190),
        ]);

        expect(analysis.columnCount).toBe(2);
        expect(analysis.text.indexOf("Left first")).toBeLessThan(analysis.text.indexOf("Right first"));
        expect(analysis.paragraphs.some((paragraph) => paragraph.text.includes("Left paragraph ends."))).toBe(true);
    });

    it("deduplicates repeated PDF text items", () => {
        const duplicate = item("Repeated text.", 50, 100);
        const analysis = analyzePdfTextItems(1, PAGE_WIDTH, PAGE_HEIGHT, [duplicate, duplicate]);
        expect(analysis.spans).toHaveLength(1);
        expect(analysis.text).toBe("Repeated text.");
    });

    it("joins wrapped hyphenated words", () => {
        const analysis = analyzePdfTextItems(1, PAGE_WIDTH, PAGE_HEIGHT, [
            item("The electro-", 50, 100, 210),
            item("chemical response is stable.", 50, 114, 210),
        ]);
        expect(analysis.text).toContain("electrochemical");
    });
});
