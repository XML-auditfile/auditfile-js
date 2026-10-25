import { ColumnType } from '../definitions/manifest.js';
import { Decimal } from '../internal/decimal.js';

/** The accessor for each column type, for messages. */
const ACCESSORS = Object.freeze({
    [ColumnType.String]: 'getString',
    [ColumnType.Decimal]: 'getDecimal',
    [ColumnType.Integer]: 'getInteger',
    [ColumnType.Date]: 'getDate',
    [ColumnType.DateTime]: 'getDateTime',
    [ColumnType.Time]: 'getTime',
    [ColumnType.Boolean]: 'getBoolean',
});

/**
 * One row of a table. {@link AuditfileRow#values} follows the column order of {@link AuditfileRow#table};
 * the JavaScript type of a value follows the column type (string, Decimal, number, Date, string "HH:MM:SS", boolean) or is null.
 *
 * Prefer the typed accessors ({@link AuditfileRow#getDecimal}, {@link AuditfileRow#getString}, ...) over {@link AuditfileRow#get}:
 * they check the column type and say what is wrong. Every accessor takes a column name or a `SchemaColumn`; in a loop over
 * many rows, look the column up once with `table.findColumn()` and pass it.
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
     * Value of a column.
     * @param {string | import('../schema/schema.js').SchemaColumn} column
     * @throws {RangeError} The column does not exist in this table.
     */
    get(column) {
        return this.values[this.#column(column).index];
    }

    /**
     * True when this table has the column (a column may exist in one version and not in another).
     * @param {string} column
     */
    has(column) {
        return this.table.findColumn(column) !== null;
    }

    /** @returns {string | null} A string column. @throws {RangeError | TypeError} */
    getString(column) {
        return this.#typed(column, ColumnType.String);
    }

    /**
     * A decimal column, or an integer column as a Decimal (a column can be integer in one version and decimal in another).
     * @returns {Decimal | null}
     * @throws {RangeError | TypeError}
     */
    getDecimal(column) {
        const value = this.#typed(column, ColumnType.Decimal, ColumnType.Integer);
        return typeof value === 'number' ? Decimal.from(value) : value;
    }

    /** @returns {number | null} An integer column. @throws {RangeError | TypeError} */
    getInteger(column) {
        return this.#typed(column, ColumnType.Integer);
    }

    /** @returns {Date | null} A date column (midnight UTC). @throws {RangeError | TypeError} */
    getDate(column) {
        return this.#typed(column, ColumnType.Date);
    }

    /** @returns {Date | null} A date-time column, or a date column at midnight UTC. @throws {RangeError | TypeError} */
    getDateTime(column) {
        return this.#typed(column, ColumnType.DateTime, ColumnType.Date);
    }

    /** @returns {string | null} A time column, "HH:MM:SS". @throws {RangeError | TypeError} */
    getTime(column) {
        return this.#typed(column, ColumnType.Time);
    }

    /** @returns {boolean | null} A boolean column. @throws {RangeError | TypeError} */
    getBoolean(column) {
        return this.#typed(column, ColumnType.Boolean);
    }

    #column(column) {
        if (typeof column === 'string') {
            const found = this.table.findColumn(column);
            if (found === null) {
                throw new RangeError(`Column '${column}' does not exist in ${this.table.name}.`);
            }

            return found;
        }

        if (this.table.columns[column?.index] !== column) {
            throw new RangeError(`Column '${column?.name}' does not belong to ${this.table.name}.`);
        }

        return column;
    }

    #typed(column, type, alternative = null) {
        const found = this.#column(column);
        if (found.type !== type && found.type !== alternative) {
            throw new TypeError(`${this.table.name}.${found.name} is a ${found.type} column, not ${type}; use ${ACCESSORS[found.type]}.`);
        }

        return this.values[found.index];
    }
}
