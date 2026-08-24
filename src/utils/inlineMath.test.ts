import { describe, expect, it } from "vitest";
import { findInlineMathMatches } from "./inlineMath";

describe("inline math delimiter detection", () => {
    it("does not pair separate currency/value dollar prefixes", () => {
        const text =
            "(20241107 $1284)、$1w ($241222 $1283) 和 BBAE 700 USD " +
            "(20241113) 共计：$2567+700==$3267";
        expect(findInlineMathMatches(text)).toEqual([]);
    });

    it("does not treat two prices as an inline formula", () => {
        expect(findInlineMathMatches("价格从 $12 调整到 $34")).toEqual([]);
    });

    it("does not pair separate symbolic value prefixes", () => {
        expect(findInlineMathMatches("代码 $ABC 调整为 $DEF")).toEqual([]);
    });

    it("keeps escaped and unmatched dollar signs as ordinary text", () => {
        expect(findInlineMathMatches(String.raw`\$x\$ and $123`)).toEqual([]);
    });

    it("still recognizes an intentionally delimited inline formula", () => {
        expect(findInlineMathMatches("公式 $x^2 + 1$ 正常")).toEqual([
            { from: 3, to: 12, tex: "x^2 + 1" },
        ]);
    });

    it("requires valid whitespace boundaries on both delimiters", () => {
        expect(findInlineMathMatches("$ x$ and $x $")).toEqual([]);
    });
});
