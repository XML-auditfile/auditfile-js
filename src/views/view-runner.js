import { ColumnType } from '../definitions/manifest.js';
import { ViewAggregate, ViewOperator } from '../definitions/names.js';
import { DiagnosticCollector, Location } from '../diagnostics/collector.js';
import { SEPARATOR } from '../internal/composite-key.js';
import { Decimal } from '../internal/decimal.js';
import { toText, tryConvert } from '../reading/value-converter.js';
import { ViewResult } from './view-result.js';

// Runs a view over rows from any store. An input row is the source row plus one slot per join;
// joins are left joins, so a missing ancestor or lookup leaves its columns null.

const MAXIMUM_DIAGNOSTICS = 100;

/** @internal */
export function runView(view, schema, rows, parameters, language) {
    const diagnostics = new DiagnosticCollector(language, MAXIMUM_DIAGNOSTICS);
    const slots = [view.source, ...view.joins.map((j) => j.table)];

    const missing = findMissing(view, schema, slots);
    if (missing !== null) {
        diagnostics.add('XAF-Q001', Location.NONE, { view: view.name, standard: schema.versionKey, missing });
        return new ViewResult(view, false, [], diagnostics.items);
    }

    const resolve = (reference) => {
        const [table, column] = split(reference);
        return new Ref(slots.indexOf(table), schema.table(table).findColumn(column));
    };

    const filters = buildFilters(view, parameters, resolve);
    const columns = view.columns.map((c) => ({ column: c, expression: c.value === null ? null : new Expression(c.value, resolve) }));
    const joins = buildJoins(view, schema, rows, resolve, diagnostics);

    const inputs = [];
    for (const source of rows(view.source)) {
        const input = new Array(slots.length).fill(null);
        input[0] = source;
        for (let i = 0; i < joins.length; i++) {
            input[i + 1] = joins[i](input);
        }

        if (filters.every((f) => f(input))) {
            inputs.push(input);
        }
    }

    const result = view.isAggregated
        ? aggregate(columns, inputs)
        : inputs.map((input) => columns.map((c) => c.expression.evaluate(input)));
    const order = view.orderBy.map((name) => columns.findIndex((c) => c.column.name === name)).filter((i) => i >= 0);
    if (order.length > 0) {
        // Array.prototype.sort is stable, like the ordering of the other implementations.
        result.sort((a, b) => {
            for (const index of order) {
                const compared = compare(a[index], b[index]);
                if (compared !== 0) {
                    return compared;
                }
            }

            return 0;
        });
    }

    return new ViewResult(view, true, result, diagnostics.items);
}

/** Returns the first table or "table.column" the view needs but the schema lacks, or null. */
function findMissing(view, schema, slots) {
    for (const table of slots) {
        if (schema.findTable(table) === null) {
            return table;
        }
    }

    for (const join of view.joins.filter((j) => j.on.length === 0)) {
        if (ancestorPath(schema, view.source, join.table) === null) {
            return join.table;
        }
    }

    const references = [
        ...view.joins.flatMap((j) => j.on.flatMap((c) => [c.left, c.right])),
        ...view.parameters.map((p) => p.column),
        ...view.columns.filter((c) => c.value !== null).flatMap((c) => [c.value.column, c.value.by]),
    ].filter((r) => typeof r === 'string');
    for (const reference of references) {
        const [table, column] = split(reference);
        if (!slots.includes(table) || schema.findTable(table)?.findColumn(column) == null) {
            return reference;
        }
    }

    return null;
}

/** Tables from the parent of `source` up to `ancestor`, or null when it is no ancestor. */
function ancestorPath(schema, source, ancestor) {
    const path = [];
    const seen = new Set();
    for (let table = schema.findTable(source)?.parent ?? null; table !== null && !seen.has(table); table = schema.findTable(table)?.parent ?? null) {
        seen.add(table);
        path.push(table);
        if (table === ancestor) {
            return path;
        }
    }

    return null;
}

function entries(parameters) {
    if (parameters === null || parameters === undefined) {
        return [];
    }

    if (parameters instanceof Map) {
        return [...parameters];
    }

    if (typeof parameters !== 'object') {
        throw new TypeError('parameters must be an object or a Map.');
    }

    return Object.entries(parameters);
}

function buildFilters(view, parameters, resolve) {
    const filters = [];
    for (const [name, raw] of entries(parameters)) {
        const parameter = view.parameters.find((p) => p.name === name);
        if (parameter === undefined) {
            throw new TypeError(`View '${view.name}' has no parameter '${name}'.`);
        }

        if (raw === null || raw === undefined) {
            continue;
        }

        const reference = resolve(parameter.column);
        const value = convert(raw, reference.column, parameter.name);
        const test = {
            '=': (c) => c === 0,
            '<': (c) => c < 0,
            '<=': (c) => c <= 0,
            '>': (c) => c > 0,
            '>=': (c) => c >= 0,
        }[parameter.operator];
        if (test === undefined) {
            throw new Error(`View '${view.name}': operator '${parameter.operator}' is not supported.`);
        }

        filters.push((input) => {
            const cell = reference.get(input);
            return cell !== null && test(compare(cell, value));
        });
    }

    return filters;
}

function buildJoins(view, schema, rows, resolve, diagnostics) {
    // One index by id over every table between the source and its joined ancestors.
    const ancestorTables = [...new Set(view.joins.filter((j) => j.on.length === 0).flatMap((j) => ancestorPath(schema, view.source, j.table)))];
    const byId = new Map();
    for (const table of ancestorTables) {
        for (const row of rows(table)) {
            byId.set(row.id, row);
        }
    }

    const joins = [];
    for (const join of view.joins) {
        if (join.on.length === 0) {
            joins.push((input) => {
                for (let row = byId.get(input[0].parentId); row !== undefined; row = byId.get(row.parentId)) {
                    if (row.table.name === join.table) {
                        return row;
                    }
                }

                return null;
            });
            continue;
        }

        const left = join.on.map((c) => resolve(c.left));
        const right = join.on.map((c) => resolve(c.right));
        const index = new Map();
        const width = Math.max(...right.map((r) => r.slot)) + 1;
        for (const row of rows(join.table)) {
            const cells = new Array(width).fill(null);
            cells[right[0].slot] = row;
            const key = keyOf(right, cells);
            if (key === null) {
                continue;
            }

            if (index.has(key)) {
                diagnostics.add('XAF-Q002', Location.NONE, { view: view.name, table: join.table, key: key.replaceAll(SEPARATOR, '/') });
            } else {
                index.set(key, row);
            }
        }

        joins.push((input) => {
            const key = keyOf(left, input);
            return key === null ? null : index.get(key) ?? null;
        });
    }

    return joins;
}

function keyOf(references, input) {
    const parts = [];
    for (const reference of references) {
        const value = reference.get(input);
        if (value === null || value === undefined) {
            return null;
        }

        parts.push(format(value));
    }

    return parts.join(SEPARATOR);
}

function aggregate(columns, inputs) {
    const groups = new Map();
    for (const input of inputs) {
        const values = columns.map((c) => c.expression?.evaluate(input) ?? null);
        const key = columns
            .map((c, i) => (c.column.aggregate === null ? (values[i] !== null ? `=${format(values[i])}` : '') : null))
            .filter((k) => k !== null)
            .join(SEPARATOR);

        let group = groups.get(key);
        if (group === undefined) {
            group = { values, aggregators: columns.map((c) => (c.column.aggregate === null ? null : new Aggregator(c))) };
            groups.set(key, group);
        }

        group.aggregators.forEach((aggregator, i) => aggregator?.add(values[i]));
    }

    // A Map keeps insertion order: groups appear in the order they were first seen.
    return [...groups.values()].map(({ values, aggregators }) => values.map((v, i) => (aggregators[i] === null ? v : aggregators[i].result)));
}

function split(reference) {
    const dot = reference.indexOf('.');
    return dot < 0 ? [reference, ''] : [reference.slice(0, dot), reference.slice(dot + 1)];
}

function convert(value, column, parameter) {
    const fail = () => new TypeError(`Parameter '${parameter}': '${String(value)}' is not a valid ${column.type}.`);
    switch (column.type) {
        case ColumnType.Decimal:
            try {
                return Decimal.from(value);
            } catch {
                throw fail();
            }

        case ColumnType.Integer: {
            const number = typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()) ? Number(value) : value;
            if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
                throw fail();
            }

            return number;
        }

        case ColumnType.Date:
        case ColumnType.DateTime: {
            if (value instanceof Date && !Number.isNaN(value.getTime())) {
                return value;
            }

            if (typeof value === 'string') {
                const parsed = tryConvert(value, value.trim().length > 10 ? ColumnType.DateTime : ColumnType.Date);
                if (parsed.ok && parsed.value !== null) {
                    return parsed.value;
                }
            }

            throw fail();
        }

        case ColumnType.Time: {
            const parsed = typeof value === 'string' ? tryConvert(value, ColumnType.Time) : { ok: false };
            if (!parsed.ok || parsed.value === null) {
                throw fail();
            }

            return parsed.value;
        }

        case ColumnType.Boolean:
            if (typeof value === 'boolean') {
                return value;
            }

            if (value === 'true' || value === 'false') {
                return value === 'true';
            }

            throw fail();

        default:
            return format(value);
    }
}

function format(value) {
    return value instanceof Decimal ? value.toString() : toText(value);
}

/** Orders null first, numbers by value, dates by time, strings ordinal. */
function compare(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) {
        return a === null || a === undefined ? (b === null || b === undefined ? 0 : -1) : 1;
    }

    if (typeof a === 'string' && typeof b === 'string') {
        return a < b ? -1 : a > b ? 1 : 0;
    }

    const numeric = (v) => v instanceof Decimal || typeof v === 'number';
    if (numeric(a) && numeric(b)) {
        return Decimal.from(a).compareTo(Decimal.from(b));
    }

    if (a instanceof Date && b instanceof Date) {
        return Math.sign(a.getTime() - b.getTime());
    }

    if (typeof a === 'boolean' && typeof b === 'boolean') {
        return Number(a) - Number(b);
    }

    const sa = format(a);
    const sb = format(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** A resolved "table.column": the input slot and the column. */
class Ref {
    constructor(slot, column) {
        this.slot = slot;
        this.column = column;
    }

    get(input) {
        return input[this.slot]?.values[this.column.index] ?? null;
    }
}

class Expression {
    #value;
    #column;
    #by;

    constructor(value, resolve) {
        this.#value = value;
        this.#column = resolve(value.column);
        this.#by = value.by === null ? null : resolve(value.by);
    }

    get type() {
        return this.#column.column.type;
    }

    evaluate(input) {
        const cell = this.#column.get(input);
        if (this.#value.operator === ViewOperator.Column || cell === null) {
            return cell;
        }

        const by = this.#by?.get(input) ?? null;
        const listed = by !== null && this.#value.codes.includes(format(by));
        if (this.#value.operator === ViewOperator.Only) {
            return listed ? cell : null;
        }

        return listed ? negate(cell) : cell;
    }
}

function negate(value) {
    if (value instanceof Decimal) {
        return value.negate();
    }

    return typeof value === 'number' ? -value : value;
}

class Aggregator {
    #kind;
    #countRows;
    #count = 0;
    #sum = Decimal.ZERO;
    #decimal;
    #extreme = null;

    constructor(output) {
        this.#kind = output.column.aggregate;
        this.#countRows = output.expression === null;
        this.#decimal = output.expression?.type === ColumnType.Decimal;
    }

    get result() {
        switch (this.#kind) {
            case ViewAggregate.Count:
                return this.#count;
            case ViewAggregate.Sum:
                return this.#decimal ? this.#sum : this.#sum.toNumber();
            default:
                return this.#extreme;
        }
    }

    add(value) {
        if (value === null && !this.#countRows) {
            return;
        }

        this.#count++;
        switch (this.#kind) {
            case ViewAggregate.Sum:
                this.#decimal ||= value instanceof Decimal;
                this.#sum = this.#sum.add(Decimal.from(value));
                break;
            case ViewAggregate.Min:
                if (this.#extreme === null || compare(value, this.#extreme) < 0) {
                    this.#extreme = value;
                }

                break;
            case ViewAggregate.Max:
                if (this.#extreme === null || compare(value, this.#extreme) > 0) {
                    this.#extreme = value;
                }

                break;
        }
    }
}
