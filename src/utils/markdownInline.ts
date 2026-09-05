/**
 * Inline Markdown matchers shared by reading and live-preview modes.
 *
 * A single asterisk followed by a digit is normally multiplication in notes
 * such as `24w/人/年*2`, so it must not start an italic span. Escaped markers
 * also stay literal.
 */
export function createItalicRegex(): RegExp {
    return /(?<![\\*])\*(?![\s*\d])(.+?)(?<![\s\\*])\*(?!\*)/gu;
}

/** Highlight syntax is %%text%%. Exactly two, unescaped percent signs are used. */
export function createHighlightRegex(): RegExp {
    return /(?<![\\%])%%(?!%)(.+?)(?<!\\)%%(?!%)/g;
}
