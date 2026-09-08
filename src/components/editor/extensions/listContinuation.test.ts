import {
    EditorState,
    Transaction,
    type TransactionSpec,
} from "@codemirror/state";
import { history, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { renumberOrderedList } from "./listContinuation";

function createStateView(initialDoc: string) {
    let state = EditorState.create({ doc: initialDoc, extensions: [history()] });
    const view = {
        get state() {
            return state;
        },
        dispatch(...input: [Transaction] | TransactionSpec[]) {
            const first = input[0];
            if (first instanceof Transaction) {
                state = first.state;
                return;
            }
            state = state.update(...input as TransactionSpec[]).state;
        },
    } as unknown as EditorView;

    return {
        view,
        get state() {
            return state;
        },
        dispatchUserEdit(spec: TransactionSpec) {
            const transaction = state.update(
                spec,
                { annotations: Transaction.userEvent.of("input.type") },
            );
            state = transaction.state;
        },
    };
}

describe("ordered-list renumber history", () => {
    it("keeps automatic renumbering out of the user's undo/redo steps", () => {
        const harness = createStateView("1. first\n2. second");

        harness.dispatchUserEdit({ changes: { from: 0, to: 1, insert: "7" } });
        expect(undoDepth(harness.state)).toBe(1);

        renumberOrderedList(harness.view);
        expect(harness.state.doc.toString()).toBe("7. first\n8. second");
        expect(undoDepth(harness.state)).toBe(1);

        expect(undo(harness.view)).toBe(true);
        renumberOrderedList(harness.view);
        expect(harness.state.doc.toString()).toBe("1. first\n2. second");
        expect(undoDepth(harness.state)).toBe(0);
        expect(redoDepth(harness.state)).toBe(1);

        expect(redo(harness.view)).toBe(true);
        renumberOrderedList(harness.view);
        expect(harness.state.doc.toString()).toBe("7. first\n8. second");
        expect(redoDepth(harness.state)).toBe(0);
    });
});
