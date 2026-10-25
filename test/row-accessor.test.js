import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auditfile, ColumnType, Decimal, MemorySink } from '../src/index.js';
import { tryConvert } from '../src/reading/value-converter.js';
import { sample, source } from './test-files.js';

// Typed accessors check the column type and name the problem; values are read in XSD notation only.

async function read() {
    const sink = new MemorySink();
    await Auditfile.read(source(sample), sink);
    return sink;
}

test('typed accessors return the value', async () => {
    const line = (await read()).rows('tr_line')[0];

    assert.ok(line.getDecimal('amnt') instanceof Decimal);
    assert.equal(line.getDecimal('amnt').toString(), '327.00');
    assert.equal(line.getString('amnt_tp'), 'D');
    assert.equal(line.getDate('eff_date').toISOString(), '2025-01-15T00:00:00.000Z');
    assert.equal(line.getDateTime('eff_date').toISOString(), '2025-01-15T00:00:00.000Z');
});

test('a column looked up once gives the same values', async () => {
    const rows = (await read()).rows('tr_line');
    const amount = rows[0].table.findColumn('amnt');

    assert.deepEqual(rows.map((r) => String(r.getDecimal(amount))), rows.map((r) => String(r.getDecimal('amnt'))));
    assert.equal(rows[0].get(amount), rows[0].get('amnt'));
});

test('a wrong type is named', async () => {
    const line = (await read()).rows('tr_line')[0];

    assert.throws(() => line.getInteger('amnt'), { name: 'TypeError', message: /tr_line\.amnt is a decimal column.*getDecimal/ });
    assert.throws(() => line.getDecimal('amnt_tp'), TypeError);
});

test('an unknown column is named and has() says so', async () => {
    const line = (await read()).rows('tr_line')[0];

    assert.throws(() => line.getDecimal('amount'), { name: 'RangeError', message: /'amount'/ });
    assert.equal(line.has('amount'), false);
    assert.equal(line.has('amnt'), true);
});

test('a column of another table is refused', async () => {
    const sink = await read();
    const amount = sink.rows('tr_line')[0].table.findColumn('amnt');

    assert.throws(() => sink.rows('header')[0].getDecimal(amount), RangeError);
});

test('date-times and times use XSD notation only', () => {
    for (const text of ['2017-01-03T10:00:00', '2017-01-03T10:00:00.5', '2017-01-03T10:00:00Z']) {
        assert.equal(tryConvert(text, ColumnType.DateTime).ok, true, text);
    }

    for (const text of ['18:30:00', '18:30:00+01:00', '18:30:00Z', '18:30:00.250']) {
        assert.deepEqual(tryConvert(text, ColumnType.Time), { ok: true, value: '18:30:00' }, text);
    }

    for (const [text, type] of [['03/01/2017 10:00:00', ColumnType.DateTime], ['2017-01-03 10:00:00', ColumnType.DateTime],
        ['2017-01-03', ColumnType.DateTime], ['2017-01-03T10:00', ColumnType.DateTime], ['18:30', ColumnType.Time],
        ['18:30:00 pm', ColumnType.Time], ['18:30:00.', ColumnType.Time], ['18:30:0012', ColumnType.Time]]) {
        assert.equal(tryConvert(text, type).ok, false, text);
    }
});
