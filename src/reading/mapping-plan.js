/** Lookup tables from absolute XML path to table, column or group, built once per import. */
export class MappingPlan {
    /** @type {Map<string, TablePlan>} */
    tables = new Map();
    /** @type {Map<string, { table: TablePlan, column: import('../schema/schema.js').SchemaColumn }>} Element and attribute columns; attributes as ".../@name". */
    columns = new Map();
    /** @type {Set<string>} Flattened elements and pure containers (no table, no column). */
    groups = new Set();

    /** @param {import('../schema/schema.js').AuditfileSchema} schema */
    constructor(schema) {
        for (const table of schema.tables) {
            const plan = new TablePlan(table);
            this.tables.set(table.path, plan);

            for (const column of table.columns) {
                if (column.path === '.') {
                    continue;
                }

                const path = `${table.path}/${column.path}`;
                this.columns.set(path, { table: plan, column });
                this.#addAncestors(path);
            }

            this.#addAncestors(table.path);
        }

        for (const path of this.tables.keys()) {
            this.groups.delete(path);
        }
    }

    #addAncestors(path) {
        for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
            this.groups.add(path.slice(0, slash));
        }
    }
}

export class TablePlan {
    /** @param {import('../schema/schema.js').SchemaTable} table */
    constructor(table) {
        this.table = table;
        /** A repeating simple element: one "value" column read from the element text. */
        this.isValueTable = table.columns.length === 1 && table.columns[0].path === '.';
    }
}
