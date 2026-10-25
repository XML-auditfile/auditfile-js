import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auditfile, AuditfileSource, AuditfileVersion, MemorySink } from '../src/index.js';

// Two journals, two periods; account 1000 is debited 350 and credited 100.
const XAF = `<?xml version="1.0" encoding="UTF-8"?>
<auditfile xmlns="http://www.auditfiles.nl/XAF/3.2"><header><fiscalYear>2025</fiscalYear><startDate>2025-01-01</startDate><endDate>2025-12-31</endDate><curCode>EUR</curCode><dateCreated>2026-01-15</dateCreated></header>
<company><companyName>Voorbeeld BV</companyName><taxRegistrationCountry>NL</taxRegistrationCountry><taxRegIdent>NL001</taxRegIdent>
<generalLedger><ledgerAccount><accID>1000</accID><accDesc>Kas</accDesc><accTp>B</accTp></ledgerAccount><ledgerAccount><accID>4000</accID><accDesc>Huur</accDesc><accTp>P</accTp></ledgerAccount><ledgerAccount><accID>8000</accID><accDesc>Omzet</accDesc><accTp>P</accTp></ledgerAccount></generalLedger>
<periods><period><periodNumber>1</periodNumber><startDatePeriod>2025-01-01</startDatePeriod><endDatePeriod>2025-06-30</endDatePeriod></period><period><periodNumber>2</periodNumber><startDatePeriod>2025-07-01</startDatePeriod><endDatePeriod>2025-12-31</endDatePeriod></period></periods>
<transactions><linesCount>6</linesCount><totalDebit>450.00</totalDebit><totalCredit>450.00</totalCredit>
<journal><jrnID>V</jrnID><desc>Verkoop</desc>
<transaction><nr>1</nr><periodNumber>1</periodNumber><trDt>2025-03-01</trDt><trLine><nr>1</nr><accID>1000</accID><docRef>F1</docRef><effDate>2025-03-01</effDate><amnt>100.00</amnt><amntTp>D</amntTp></trLine><trLine><nr>2</nr><accID>8000</accID><docRef>F1</docRef><effDate>2025-03-01</effDate><amnt>100.00</amnt><amntTp>C</amntTp></trLine></transaction>
<transaction><nr>2</nr><periodNumber>2</periodNumber><trDt>2025-09-01</trDt><trLine><nr>1</nr><accID>1000</accID><docRef>F2</docRef><effDate>2025-09-01</effDate><amnt>250.00</amnt><amntTp>D</amntTp></trLine><trLine><nr>2</nr><accID>8000</accID><docRef>F2</docRef><effDate>2025-09-01</effDate><amnt>250.00</amnt><amntTp>C</amntTp></trLine></transaction>
</journal>
<journal><jrnID>M</jrnID><desc>Memoriaal</desc>
<transaction><nr>3</nr><periodNumber>2</periodNumber><trDt>2025-10-01</trDt><trLine><nr>1</nr><accID>4000</accID><docRef>H1</docRef><effDate>2025-10-01</effDate><amnt>100.00</amnt><amntTp>D</amntTp></trLine><trLine><nr>2</nr><accID>1000</accID><docRef>H1</docRef><effDate>2025-10-01</effDate><amnt>100.00</amnt><amntTp>C</amntTp></trLine></transaction>
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
