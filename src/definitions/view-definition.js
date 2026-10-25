import { array, isObject, object, objects, optionalString, string, strings } from '../internal/json.js';
import { runView } from '../views/view-runner.js';
import { exists, readJson } from './resources.js';
import { LocalizedText, TextLanguage } from './localized-text.js';
import { oneOf, ViewAggregate, ViewOperator } from './names.js';

/**
 * A view from views/<type>.json: a report over the rows of an import, such as a trial balance.
 * Run it with {@link ViewDefinition#run} on any store that can hand out the rows of a table.
 */
export class ViewDefinition {
    /** @internal */
    constructor(json) {
        /** View name, e.g. "trial_balance". */
        this.name = string(json, 'name');
        /** Display name. */
        this.label = LocalizedText.from(object(json, 'label'));
        /** What the view shows. */
        this.description = LocalizedText.from(object(json, 'description'));
        /** The table with one input row per row of the view (before grouping). */
        this.source = string(json, 'source');
        /** Tables joined to the source: an ancestor of the source, or a lookup on key columns. */
        this.joins = Object.freeze(objects(json, 'joins').map((j) => new ViewJoin(j)));
        /** Optional filters. */
        this.parameters = Object.freeze(objects(json, 'parameters').map((p) => new ViewParameter(p)));
        /** Output columns. When any column aggregates, the other columns group. */
        this.columns = Object.freeze(objects(json, 'columns').map((c) => new ViewColumn(c)));
        /** Output column names to sort by, ascending. */
        this.orderBy = Object.freeze(strings(json, 'orderBy'));
        Object.freeze(this);
    }

    /** True when at least one column aggregates. */
    get isAggregated() {
        return this.columns.some((c) => c.aggregate !== null);
    }

    /**
     * Runs the view. `rows` returns the rows of a table by name.
     * `parameters` holds filter values by parameter name; null and undefined values are ignored.
     * @param {import('../schema/schema.js').AuditfileSchema} schema
     * @param {(table: string) => Iterable<import('../reading/row.js').AuditfileRow>} rows
     * @param {Record<string, unknown> | Map<string, unknown> | null} [parameters]
     * @param {'nl' | 'en'} [language]
     * @returns {import('../views/view-result.js').ViewResult}
     * @throws {TypeError} A parameter is unknown or its value cannot be converted.
     */
    run(schema, rows, parameters = null, language = TextLanguage.Dutch) {
        if (schema === null || schema === undefined) {
            throw new TypeError('schema is required.');
        }

        if (typeof rows !== 'function') {
            throw new TypeError('rows must be a function that returns the rows of a table.');
        }

        return runView(this, schema, rows, parameters, language);
    }

    toString() {
        return this.name;
    }

    /** @internal */
    static load(type) {
        const name = `views/${type}.json`;
        return exists(name) ? Object.freeze(objects(readJson(name), 'views').map((v) => new ViewDefinition(v))) : Object.freeze([]);
    }
}

/** A table joined to the source of a view. */
export class ViewJoin {
    /** @internal */
    constructor(json) {
        /** Table name, as the view refers to it. */
        this.table = string(json, 'table');
        /**
         * Names of the same table in versions that call it differently: when a version lacks {@link ViewJoin#table},
         * the first alternative it has is joined.
         */
        this.alternatives = Object.freeze(strings(json, 'alternatives'));
        /** Equality conditions; empty means {@link ViewJoin#table} is an ancestor of the source. */
        this.on = Object.freeze(array(json, 'on').map((pair) => {
            if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
                throw new SyntaxError('Embedded JSON: a join condition must be a pair of column references.');
            }

            return new ViewJoinCondition(pair[0], pair[1]);
        }));
        Object.freeze(this);
    }
}

/** One equality condition of a join, as "table.column" references. */
export class ViewJoinCondition {
    constructor(left, right) {
        /** Column of the source or an earlier join. */
        this.left = left;
        /** Column of the joined table. */
        this.right = right;
        Object.freeze(this);
    }
}

/** An optional filter of a view. */
export class ViewParameter {
    /** @internal */
    constructor(json) {
        /** Parameter name, e.g. "period_from". */
        this.name = string(json, 'name');
        /** Display name. */
        this.label = LocalizedText.from(object(json, 'label'));
        /** The filtered column, as "table.column". */
        this.column = string(json, 'column');
        /** "=", "<", "<=", ">" or ">=". */
        this.operator = string(json, 'operator');
        Object.freeze(this);
    }
}

/** An output column of a view. */
export class ViewColumn {
    /** @internal */
    constructor(json) {
        /** Column name. */
        this.name = string(json, 'name');
        /** Display name. */
        this.label = LocalizedText.from(object(json, 'label'));
        /** The aggregate, one of {@link ViewAggregate}, or null for a grouping column. */
        const aggregate = optionalString(json, 'aggregate');
        this.aggregate = aggregate === null ? null : oneOf(aggregate, ViewAggregate, 'view aggregate');
        /** The value per input row; null for a row count. */
        this.value = Object.prototype.hasOwnProperty.call(json, 'value') && json.value !== null ? ViewValue.from(json.value) : null;
        Object.freeze(this);
    }
}

/** How a view column gets its value from an input row. */
export class ViewValue {
    constructor(operator, column, by, codes, prefix = null) {
        /** How the value is taken from `column`, one of {@link ViewOperator}. */
        this.operator = operator;
        /** The value column, as "table.column". */
        this.column = column;
        /** The column holding the code, as "table.column". */
        this.by = by;
        /** Codes for "only" (in) or "signed" (negative). */
        this.codes = Object.freeze([...codes]);
        /** Placeholder prefix for "pseudonym", e.g. "REL" for REL-1, REL-2, ... */
        this.prefix = prefix;
        Object.freeze(this);
    }

    /** @internal */
    static from(json) {
        if (typeof json === 'string') {
            return new ViewValue(ViewOperator.Column, json, null, []);
        }

        if (isObject(json)) {
            return new ViewValue(oneOf(string(json, 'op'), ViewOperator, 'view value operator'), string(json, 'value'), optionalString(json, 'by'),
                [...strings(json, 'in'), ...strings(json, 'negative')], optionalString(json, 'prefix'));
        }

        throw new SyntaxError('Embedded JSON: invalid view column value.');
    }
}
