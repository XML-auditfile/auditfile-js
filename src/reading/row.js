/**
 * One row of a table. {@link AuditfileRow#values} follows the column order of {@link AuditfileRow#table};
 * the JavaScript type of a value follows the column type (string, Decimal, number, Date, string "HH:MM:SS", boolean) or is null.
 */
export class AuditfileRow {
    /** @internal */
    constructor(table, id, parentId, ordinal, part, values) {
        /** @type {import('../schema/schema.js').SchemaTable} The table this row belongs to. */
        this.table = table;
        /** Unique within the import; assigned in document order. */
        this.id = id;
        /** Id of the parent row, or null for the root. */
        this.parentId = parentId;
        /** Position under the parent row (1-based), per table. */
        this.ordinal = ordinal;
        /** Source part the row came from (1-based). */
        this.part = part;
        /** @type {readonly unknown[]} Column values in column order. */
        this.values = Object.freeze(values);
        Object.freeze(this);
    }

    /**
     * Value of a column by name.
     * @param {string} column
     * @throws {RangeError} The column does not exist.
     */
    get(column) {
        const found = this.table.findColumn(column);
        if (found === null) {
            throw new RangeError(`Column '${column}' does not exist in ${this.table.name}.`);
        }

        return this.values[found.index];
    }
}
