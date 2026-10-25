import { Location } from '../diagnostics/collector.js';
import { Decimal } from '../internal/decimal.js';

/** Line count and debit and credit totals. */
class Totals {
    count = 0;
    debit = Decimal.ZERO;
    credit = Decimal.ZERO;

    add(amount, type) {
        this.count++;
        if (!(amount instanceof Decimal)) {
            return;
        }

        if (type === 'D') {
            this.debit = this.debit.add(amount);
        } else if (type === 'C') {
            this.credit = this.credit.add(amount);
        }
    }
}

function get(map, key) {
    let totals = map.get(key);
    if (totals === undefined) {
        totals = new Totals();
        map.set(key, totals);
    }

    return totals;
}

/** Compares a header value with the total of the lines. */
function compare(row, field, expected, actual, diagnostics) {
    if (expected === null || expected === undefined) {
        return;
    }

    const equal = expected instanceof Decimal ? expected.equals(actual) : expected === actual;
    if (!equal) {
        diagnostics.add('XAF-R002', new Location(row.part, null, null, row.table.path),
            { field, table: row.table.name, expected: String(expected), actual: String(actual) });
    }
}

/** Header counts and totals of one kind of line, e.g. the transaction lines against company/transactions. */
class TotalsRule {
    #byParent = new Map();
    #all = new Totals();

    constructor(child, owner, perParent, count, debit, credit) {
        this.child = child;
        this.owner = owner;
        this.perParent = perParent;
        this.count = count;
        this.debit = debit;
        this.credit = credit;
    }

    onRow(row, diagnostics) {
        if (row.table === this.child) {
            const totals = this.perParent && row.parentId !== null ? get(this.#byParent, row.parentId) : this.#all;
            totals.add(row.get('amnt'), row.get('amnt_tp'));
            return;
        }

        if (row.table !== this.owner) {
            return;
        }

        let actual = this.#all;
        if (this.perParent) {
            actual = this.#byParent.get(row.id) ?? new Totals();
            this.#byParent.delete(row.id);
        }

        compare(row, this.count, row.get(this.count), actual.count, diagnostics);
        compare(row, this.debit, row.get(this.debit), actual.debit, diagnostics);
        compare(row, this.credit, row.get(this.credit), actual.credit, diagnostics);
    }
}

/**
 * Business rules for Auditfile Financieel (XAF):
 * every transaction balances, and the counts and totals in the headers match the lines.
 * Rules whose tables or columns do not exist in a version are skipped.
 */
export class XafRules {
    #diagnostics;
    #transactions = new Map();
    #rules = [];
    #line;
    #transaction;

    constructor(schema, diagnostics) {
        this.#diagnostics = diagnostics;
        this.#line = schema.findTable('tr_line');
        this.#transaction = schema.findTable('transaction');

        this.#addRule(schema, 'tr_line', 'company', false, 'transactions_lines_count', 'transactions_total_debit', 'transactions_total_credit');
        this.#addRule(schema, 'ob_line', 'company', false, 'opening_balance_lines_count', 'opening_balance_total_debit', 'opening_balance_total_credit');
        this.#addRule(schema, 'sb_line', 'subledger', true, 'lines_count', 'total_debit', 'total_credit');
        this.#addRule(schema, 'ob_sb_line', 'ob_subledger', true, 'lines_count', 'total_debit', 'total_credit');
    }

    onRow(row) {
        if (row.table === this.#line && row.parentId !== null) {
            get(this.#transactions, row.parentId).add(row.get('amnt'), row.get('amnt_tp'));
        } else if (row.table === this.#transaction && this.#transactions.has(row.id)) {
            const lines = this.#transactions.get(row.id);
            this.#transactions.delete(row.id);
            if (!lines.debit.equals(lines.credit)) {
                this.#diagnostics.add('XAF-R001', new Location(row.part, null, null, row.table.path),
                    { transaction: row.get('nr'), debit: lines.debit, credit: lines.credit });
            }
        }

        for (const rule of this.#rules) {
            rule.onRow(row, this.#diagnostics);
        }
    }

    onEnd() {}

    #addRule(schema, child, owner, perParent, count, debit, credit) {
        const childTable = schema.findTable(child);
        const ownerTable = schema.findTable(owner);
        if (childTable?.findColumn('amnt') == null || childTable.findColumn('amnt_tp') === null || ownerTable?.findColumn(count) == null) {
            return;
        }

        this.#rules.push(new TotalsRule(childTable, ownerTable, perParent, count, debit, credit));
    }
}
