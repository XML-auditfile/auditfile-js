/**
 * The paths of an import as a tree, built once per import: every node knows its table, column or group.
 * Reading an element is then one lookup of its local name under the current node, instead of building the
 * full path as a string and looking that up. Only known paths have a node, so a file cannot make the tree grow.
 */
export class MappingPlan {
    /** @type {Map<string, PathNode>} */
    #nodes = new Map();
    /** Above the root element: its only child is the root element of the version. */
    root = new PathNode('');

    /** @param {import('../schema/schema.js').AuditfileSchema} schema */
    constructor(schema) {
        const plans = [];
        for (const table of schema.tables) {
            const plan = new TablePlan(table);
            plans.push(plan);
            this.#node(table.path).table = plan;

            for (const column of table.columns) {
                if (column.path !== '.') {
                    this.#node(`${table.path}/${column.path}`).column = { table: plan, column };
                }
            }
        }

        for (const node of this.#nodes.values()) {
            node.isGroup = node.table === null && node.column === null;
        }

        for (const plan of plans) {
            plan.required = plan.table.columns
                .filter((c) => c.minOccurs >= 1 && c.path !== '.')
                .map((c) => {
                    const slash = c.path.lastIndexOf('/');
                    return { column: c, group: slash > 0 ? this.#nodes.get(`${plan.table.path}/${c.path.slice(0, slash)}`) : null };
                });
        }
    }

    #node(path) {
        let node = this.#nodes.get(path);
        if (node !== undefined) {
            return node;
        }

        const slash = path.lastIndexOf('/');
        const parent = slash < 0 ? this.root : this.#node(path.slice(0, slash));
        const name = slash < 0 ? path : path.slice(slash + 1);
        node = new PathNode(path);
        (name.startsWith('@') ? parent.attributes : parent.children).set(name.replace(/^@/, ''), node);
        this.#nodes.set(path, node);
        return node;
    }
}

/** A known element or attribute path. */
export class PathNode {
    /** @type {TablePlan | null} */
    table = null;
    /** @type {{ table: TablePlan, column: import('../schema/schema.js').SchemaColumn } | null} */
    column = null;
    /** A flattened element or pure container: no table and no column. */
    isGroup = false;
    /** @type {Map<string, PathNode>} Child elements by local name. */
    children = new Map();
    /** @type {Map<string, PathNode>} Attributes by local name. */
    attributes = new Map();

    /** @param {string} path The full path, e.g. "auditfile/company/transactions"; attributes as ".../@name". */
    constructor(path) {
        this.path = path;
    }

    /** The path of an unknown child, for a diagnostic. */
    childPath(localName) {
        return this.path === '' ? localName : `${this.path}/${localName}`;
    }
}

export class TablePlan {
    /** @type {{ column: import('../schema/schema.js').SchemaColumn, group: PathNode | null }[]} Columns with minOccurs ≥ 1, with the group they are in. */
    required = [];

    /** @param {import('../schema/schema.js').SchemaTable} table */
    constructor(table) {
        this.table = table;
        /** A repeating simple element: one "value" column read from the element text. */
        this.isValueTable = table.columns.length === 1 && table.columns[0].path === '.';
    }
}
