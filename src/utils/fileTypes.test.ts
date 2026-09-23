import { describe, expect, it } from "vitest";
import { getFileHandler, isPdfPath } from "./fileTypes";

describe("PDF workspace routing", () => {
    it("routes PDF files to the built-in PDF workspace", () => {
        expect(getFileHandler("papers/example.pdf", () => false)).toBe("pdf");
        expect(getFileHandler("papers/EXAMPLE.PDF", () => false)).toBe("pdf");
    });

    it("does not treat non-PDF documents as PDF workspace files", () => {
        expect(isPdfPath("notes/paper.md")).toBe(false);
        expect(isPdfPath("attachments/paper.pdf")).toBe(true);
    });

    it("still gives plugin views precedence", () => {
        expect(getFileHandler("papers/example.pdf", (extension) => extension === "pdf"))
            .toBe("plugin");
    });
});
