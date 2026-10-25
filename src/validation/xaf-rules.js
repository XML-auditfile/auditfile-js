import { ColumnType } from '../definitions/manifest.js';
import { Location } from '../diagnostics/collector.js';
import { Decimal } from '../internal/decimal.js';

/** Audit file type these rules apply to. */
export const XAF = 'xaf';

const AMOUNT = 'amnt';
const AMOUNT_TYPE = 'amnt_tp';
const DEBIT = 'D';
const CREDIT = 'C';

/**
 * A table of lines with an amount and a debit/credit indicator, with its columns looked up once.
 * Null when the table or a column does not exist, or has another type, in this version.
 */
function findLines(table) {
    const amount = table?.findColumn(AMOUNT) ?? null;
    const amountType = table?.findColumn(AMOUNT_TYPE) ?? null;
    if (amount === null || amountType === null || ![ColumnType.Decimal, ColumnType.Integer].includes(amount.type)
        || amountType.type !== ColumnType.String) {
        return null;
    }

    return { table, amount, amountType };
}

/** Line count and debit and credit totals. */
class Totals {
    count = 0;
    debit = Decimal.ZERO;
    credit = Decimal.ZERO;

    add(row, lines) {
        this.count++;
        const amount = row.getDecimal(lines.amount);
        if (amount === null) {
            return;
        }

        const type = row.getString(lines.amountType);
        if (type === DEBIT) {
            this.debit = this.debit.add(amount);
        } else if (type === CREDIT) {
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

    constructor(lines, owner, perParent, count, debit, credit) {
        this.lines = lines;
        this.owner = owner;
        this.perParent = perParent;
        this.count = count;
        this.debit = debit;
        this.credit = credit;
    }

    onRow(row, diagnostics) {
        if (row.table === this.lines.table) {
            const totals = this.perParent && row.parentId !== null ? get(this.#byParent, row.parentId) : this.#all;
            totals.add(row, this.lines);
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

        compare(row, this.count.name, row.getInteger(this.count), actual.count, diagnostics);
        compare(row, this.debit.name, row.getDecimal(this.debit), actual.debit, diagnostics);
        compare(row, this.credit.name, row.getDecimal(this.credit), actual.credit, diagnostics);
    }
}

/**
 * Business rules for Auditfile Financieel (XAF):
 * every transaction balances, and the counts and totals in the headers match the lines.
 * Rules whose tables or columns do not exist in a version are skipped. Columns are looked up once, not per row.
 */
export class XafRules {
    #diagnostics;
    #transactions = new Map();
    #rules = [];
    #lines;
    #transaction;
    #transactionNumber;

    constructor(schema, diagnostics) {
        this.#diagnostics = diagnostics;
        this.#lines = findLines(schema.findTable('tr_line'));
        this.#transaction = schema.findTable('transaction');
        this.#transactionNumber = this.#transaction?.findColumn('nr') ?? null;

        this.#addRule(schema, 'tr_line', 'company', false, 'transactions_lines_count', 'transactions_total_debit', 'transactions_total_credit');
        this.#addRule(schema, 'ob_line', 'company', false, 'opening_balance_lines_count', 'opening_balance_total_debit', 'opening_balance_total_credit');
        this.#addRule(schema, 'sb_line', 'subledger', true, 'lines_count', 'total_debit', 'total_credit');
        this.#addRule(schema, 'ob_sb_line', 'ob_subledger', true, 'lines_count', 'total_debit', 'total_credit');
    }

    onRow(row) {
        if (this.#lines !== null && row.table === this.#lines.table && row.parentId !== null) {
            get(this.#transactions, row.parentId).add(row, this.#lines);
        } else if (row.table === this.#transaction && this.#transactions.has(row.id)) {
            const lines = this.#transactions.get(row.id);
            this.#transactions.delete(row.id);
            if (!lines.debit.equals(lines.credit)) {
                this.#diagnostics.add('XAF-R001', new Location(row.part, null, null, row.table.path),
                    { transaction: this.#transactionNumber === null ? null : row.get(this.#transactionNumber), debit: lines.debit, credit: lines.credit });
            }
        }

        for (const rule of this.#rules) {
            rule.onRow(row, this.#diagnostics);
        }
    }

    onEnd() {}

    #addRule(schema, child, owner, perParent, count, debit, credit) {
        const lines = findLines(schema.findTable(child));
        const ownerTable = schema.findTable(owner);
        const countColumn = ownerTable?.findColumn(count) ?? null;
        const debitColumn = ownerTable?.findColumn(debit) ?? null;
        const creditColumn = ownerTable?.findColumn(credit) ?? null;
        if (lines === null || countColumn?.type !== ColumnType.Integer
            || debitColumn?.type !== ColumnType.Decimal || creditColumn?.type !== ColumnType.Decimal) {
            return;
        }

        this.#rules.push(new TotalsRule(lines, ownerTable, perParent, countColumn, debitColumn, creditColumn));
    }
}
