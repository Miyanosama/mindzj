/**
 * Build the shared inline-math matcher used by reading and live-preview modes.
 *
 * The closing `$` may not be followed by a letter, digit, or underscore. This
 * is the important currency/value safeguard: text such as `$1284、$1w` or
 * `$ABC and $DEF` contains several prefixes, not a math span whose delimiters
 * should disappear. Math also may not cross another dollar sign or source row.
 */
export function createInlineMathRegex(): RegExp {
    return /(?<![\\$])\$(?![$\s])([^$\n]+?)(?<![\s\\])\$(?![$\p{L}\p{N}_])/gu;
}

export interface InlineMathMatch {
    from: number;
    to: number;
    tex: string;
}

export function findInlineMathMatches(text: string): InlineMathMatch[] {
    const matches: InlineMathMatch[] = [];
    const regex = createInlineMathRegex();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        matches.push({
            from: match.index,
            to: match.index + match[0].length,
            tex: match[1]!,
        });
    }
    return matches;
}
