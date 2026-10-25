/** The outcome of running a {@link ViewDefinition}. */
export class ViewResult {
    /** @internal */
    constructor(view, isAvailable, rows, diagnostics) {
        /** @type {import('../definitions/view-definition.js').ViewDefinition} The view that was run. */
        this.view = view;
        /** False when the version lacks a table or column the view needs (XAF-Q001); there are no rows then. */
        this.isAvailable = isAvailable;
        /** @type {readonly (readonly unknown[])[]} Result rows, sorted by the view's orderBy; one value per column. */
        this.rows = Object.freeze(rows.map((row) => Object.freeze(row)));
        /** @type {readonly import('../diagnostics/diagnostic.js').Diagnostic[]} Findings while running the view. */
        this.diagnostics = Object.freeze([...diagnostics]);
        Object.freeze(this);
    }

    /** Output columns; each row has one value per column, in this order. */
    get columns() {
        return this.view.columns;
    }
}
