import { Location } from '../diagnostics/collector.js';
import { SEPARATOR } from '../internal/composite-key.js';
import { toText } from '../reading/value-converter.js';

const MAX_PENDING_PER_REFERENCE = 100_000;

/**
 * Checks keys (unique) and references (existing) from the schema.
 * Only key values and unresolved reference values are kept in memory; references are resolved at the end,
 * so a reference to a key that appears later (e.g. in a later part) is still found.
 */
export class ReferenceChecker {
    #diagnostics;
    /** @type {Map<string, KeyState>} */
    #keysByName = new Map();
    /** @type {Map<object, KeyState[]>} */
    #keysByTable = new Map();
    /** @type {Map<object, ReferenceState[]>} */
    #referencesByTable = new Map();

    constructor(schema, diagnostics) {
        this.#diagnostics = diagnostics;

        for (const table of schema.tables) {
            for (const key of table.keys) {
                const state = new KeyState(table, indexes(table, key.columns));
                this.#keysByName.set(key.name, state);
                add(this.#keysByTable, table, state);
            }
        }

        for (const table of schema.tables) {
            for (const reference of table.references) {
                const key = this.#keysByName.get(reference.key);
                if (key !== undefined) {
                    add(this.#referencesByTable, table, new ReferenceState(table, reference.columns.join(', '), indexes(table, reference.columns), key));
                }
            }
        }
    }

    onRow(row) {
        for (const key of this.#keysByTable.get(row.table) ?? []) {
            const value = composite(row, key.columns);
            if (value !== null) {
                if (key.values.has(value)) {
                    this.#diagnostics.add('XAF-R004', new Location(row.part, null, null, row.table.path), { value: display(value), table: row.table.name });
                } else {
                    key.values.add(value);
                }
            }
        }

        for (const reference of this.#referencesByTable.get(row.table) ?? []) {
            const value = composite(row, reference.columns);
            if (value === null || reference.key.values.has(value) || reference.pending.has(value)) {
                continue;
            }

            if (reference.pending.size < MAX_PENDING_PER_REFERENCE) {
                reference.pending.add(value);
            } else if (!reference.overflowed) {
                // From here on new values are not checked; say so once, so a clean result is not mistaken for a complete one.
                reference.overflowed = true;
                this.#diagnostics.add('XAF-R017', new Location(row.part, null, null, row.table.path), {
                    table: row.table.name, column: reference.columnNames, target: reference.key.table.name, max: MAX_PENDING_PER_REFERENCE,
                });
            }
        }
    }

    onEnd() {
        for (const references of this.#referencesByTable.values()) {
            for (const reference of references) {
                const missing = [...reference.pending].filter((v) => !reference.key.values.has(v)).sort(ordinal);
                for (const value of missing) {
                    this.#diagnostics.add('XAF-R003', new Location(null, null, null, reference.table.path), {
                        table: reference.table.name, column: reference.columnNames, value: display(value), target: reference.key.table.name,
                    });
                }
            }
        }
    }
}

/** Ordinal string order (UTF-16 code units), as everywhere in this reader. */
function ordinal(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function composite(row, columns) {
    const parts = [];
    for (const column of columns) {
        const value = row.values[column];
        if (value === null || value === undefined) {
            return null;
        }

        parts.push(toText(value));
    }

    return parts.join(SEPARATOR);
}

function display(value) {
    return value.replaceAll(SEPARATOR, '/');
}

function indexes(table, columns) {
    return columns.map((name) => {
        const column = table.findColumn(name);
        if (column === null) {
            throw new Error(`Key column ${name} not in ${table.name}.`);
        }

        return column.index;
    });
}

function add(map, table, item) {
    const list = map.get(table) ?? [];
    list.push(item);
    map.set(table, list);
}

class KeyState {
    values = new Set();

    constructor(table, columns) {
        this.table = table;
        this.columns = columns;
    }
}

class ReferenceState {
    pending = new Set();
    /** True once the pending limit was reached and XAF-R017 was reported. */
    overflowed = false;

    constructor(table, columnNames, columns, key) {
        this.table = table;
        this.columnNames = columnNames;
        this.columns = columns;
        this.key = key;
    }
}
