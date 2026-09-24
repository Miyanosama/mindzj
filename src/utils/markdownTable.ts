/**
 * Match a GFM table delimiter row, including the indentation AI responses
 * commonly add before a table. The old expression started with an optional
 * pipe and only then accepted whitespace, so `    | --- | --- |` was rejected
 * even though it is valid Markdown.
 */
export function isMarkdownTableDelimiterRow(line: string): boolean {
    const cells = line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|");

    return (
        cells.length > 1 &&
        cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell))
    );
}
