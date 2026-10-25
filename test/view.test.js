import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auditfile, AuditfileSource, AuditfileVersion, MemorySink } from '../src/index.js';

// Two journals, two periods; account 1000 is debited 350 and credited 100. Two lines name customer C1 and share
// the description "Verkoop"; one line names supplier C2.
const XAF = `<?xml version="1.0" encoding="UTF-8"?>
<auditfile xmlns="http://www.auditfiles.nl/XAF/3.2"><header><fiscalYear>2025</fiscalYear><startDate>2025-01-01</startDate><endDate>2025-12-31</endDate><curCode>EUR</curCode><dateCreated>2026-01-15</dateCreated></header>
<company><companyName>Voorbeeld BV</companyName><taxRegistrationCountry>NL</taxRegistrationCountry><taxRegIdent>NL001</taxRegIdent>
<customersSuppliers><customerSupplier><custSupID>C1</custSupID><custSupName>Jansen BV</custSupName></customerSupplier><customerSupplier><custSupID>C2</custSupID><custSupName>Verhuur BV</custSupName></customerSupplier></customersSuppliers>
<generalLedger><ledgerAccount><accID>1000</accID><accDesc>Kas</accDesc><accTp>B</accTp></ledgerAccount><ledgerAccount><accID>4000</accID><accDesc>Huur</accDesc><accTp>P</accTp></ledgerAccount><ledgerAccount><accID>8000</accID><accDesc>Omzet</accDesc><accTp>P</accTp></ledgerAccount></generalLedger>
<periods><period><periodNumber>1</periodNumber><startDatePeriod>2025-01-01</startDatePeriod><endDatePeriod>2025-06-30</endDatePeriod></period><period><periodNumber>2</periodNumber><startDatePeriod>2025-07-01</startDatePeriod><endDatePeriod>2025-12-31</endDatePeriod></period></periods>
<transactions><linesCount>6</linesCount><totalDebit>450.00</totalDebit><totalCredit>450.00</totalCredit>
<journal><jrnID>V</jrnID><desc>Verkoop</desc>
<transaction><nr>1</nr><periodNumber>1</periodNumber><trDt>2025-03-01</trDt><trLine><nr>1</nr><accID>1000</accID><docRef>F1</docRef><effDate>2025-03-01</effDate><desc>Verkoop</desc><amnt>100.00</amnt><amntTp>D</amntTp><custSupID>C1</custSupID></trLine><trLine><nr>2</nr><accID>8000</accID><docRef>F1</docRef><effDate>2025-03-01</effDate><amnt>100.00</amnt><amntTp>C</amntTp></trLine></transaction>
<transaction><nr>2</nr><periodNumber>2</periodNumber><trDt>2025-09-01</trDt><trLine><nr>1</nr><accID>1000</accID><docRef>F2</docRef><effDate>2025-09-01</effDate><desc>Verkoop</desc><amnt>250.00</amnt><amntTp>D</amntTp><custSupID>C1</custSupID></trLine><trLine><nr>2</nr><accID>8000</accID><docRef>F2</docRef><effDate>2025-09-01</effDate><amnt>250.00</amnt><amntTp>C</amntTp></trLine></transaction>
</journal>
<journal><jrnID>M</jrnID><desc>Memoriaal</desc>
<transaction><nr>3</nr><periodNumber>2</periodNumber><trDt>2025-10-01</trDt><trLine><nr>1</nr><accID>4000</accID><docRef>H1</docRef><effDate>2025-10-01</effDate><desc>Huur oktober</desc><amnt>100.00</amnt><amntTp>D</amntTp><custSupID>C2</custSupID></trLine><trLine><nr>2</nr><accID>1000</accID><docRef>H1</docRef><effDate>2025-10-01</effDate><amnt>100.00</amnt><amntTp>C</amntTp></trLine></transaction>
</journal></transactions></company></auditfile>`;

const view = (name) => AuditfileVersion.Financial.V3_2.findView(name);
const text = (row) => row.map((v) => (v === null ? null : String(v)));

async function load(xml) {
    const sink = new MemorySink();
    const bytes = new TextEncoder().encode(xml);
    const report = await Auditfile.read(AuditfileSource.fromFactory(() => bytes, 'views.xaf'), sink);
    assert.equal(report.loaded, true, report.diagnostics.join('\n'));
    return sink;
}

test('trial balance sums debit, credit and balance per account', async () => {
    const sink = await load(XAF);

    const result = sink.run(view('trial_balance'));

    assert.equal(result.isAvailable, true);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.rows.map((r) => r[0]), ['1000', '4000', '8000']);
    assert.deepEqual(text(result.rows[0]), ['1000', 'Kas', 'B', '350.00', '100.00', '250.00']);
    assert.equal(String(result.rows[2][5]), '-350.00');
});

test('parameters filter the input rows', async () => {
    const sink = await load(XAF);

    const result = sink.run(view('trial_balance'), { period_from: 2, date_to: '2025-09-30', period_to: null });

    assert.deepEqual(result.rows.map((r) => r[0]), ['1000', '8000']);
    assert.equal(String(result.rows[0][5]), '250.00');
});

test('ancestor joins reach through the parent chain', async () => {
    const sink = await load(XAF);

    const result = sink.run(view('journal_totals'));

    const memoriaal = result.rows[0];
    assert.equal(memoriaal[0], 'M');
    assert.equal(memoriaal[3], 2);
    assert.equal(String(memoriaal[6]), '0.00');
});

test('ledger shows names and a signed amount in file order', async () => {
    const sink = await load(XAF);

    const result = sink.run(view('ledger'));

    assert.equal(result.isAvailable, true);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.rows.length, 6);
    const first = text(result.rows[0]);
    first[4] = result.rows[0][4].toISOString().slice(0, 10);
    assert.deepEqual(first, ['V', 'Verkoop', '1', null, '2025-03-01', '1', '1', '1000', 'Kas', 'C1', 'Jansen BV', 'Verkoop', 'F1', '100.00']);
    assert.deepEqual(text([...result.rows[1].slice(7, 11), result.rows[1][13]]), ['8000', 'Omzet', null, null, '-100.00']);
    assert.deepEqual(result.rows.map((r) => r[0]), ['V', 'V', 'V', 'V', 'M', 'M']);
});

test('pseudonymized ledger replaces descriptions and names', async () => {
    const sink = await load(XAF);

    const result = sink.run(view('ledger_pseudonymized'));

    const first = text(result.rows[0]);
    first[4] = null;
    assert.deepEqual(first, ['V', 'JRN-1', '1', null, null, '1', '1', '1000', 'ACC-1', 'C1', 'REL-1', 'DESC-1', 'F1', '100.00']);
    assert.equal(result.rows[1][8], 'ACC-3');
    assert.equal(result.rows[2][11], 'DESC-1');
    assert.deepEqual([1, 8, 10, 11].map((i) => result.rows[4][i]), ['JRN-2', 'ACC-2', 'REL-2', 'DESC-2']);
});

test('pseudonyms do not depend on filters', async () => {
    const sink = await load(XAF);

    const result = sink.run(view('ledger_pseudonymized'), { journal: 'M' });

    assert.deepEqual(result.rows.map((r) => r[8]), ['ACC-2', 'ACC-1']);
});

test('unknown parameter is rejected', async () => {
    const sink = await load(XAF);

    assert.throws(() => sink.run(view('trial_balance'), { year: 2025 }), TypeError);
});

test('view of another type is not available', async () => {
    const sink = await load(XAF);
    const payroll = AuditfileVersion.all.find((v) => v.type === 'xas').findView('hours');

    const result = sink.run(payroll);

    assert.equal(result.isAvailable, false);
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.diagnostics.map((d) => d.code), ['XAF-Q001']);
});

test('duplicate lookup key uses the first row with a warning', async () => {
    // Loading rejects duplicate keys, so the store hands out a ledger account twice: the first copy last.
    const sink = await load(XAF);
    const huur = sink.rows('ledger_account')[1];
    const rows = (table) => (table === 'ledger_account' ? [...sink.rows(table), huur] : sink.rows(table));

    const result = view('trial_balance').run(sink.schema, rows);

    assert.equal(result.rows[1][1], 'Huur');
    assert.deepEqual(result.diagnostics.map((d) => d.code), ['XAF-Q002']);
});
