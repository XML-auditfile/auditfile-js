import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ColumnType, Decimal } from '../src/index.js';
import { tryConvert } from '../src/reading/value-converter.js';

test('decimals use XSD notation', () => {
    for (const [text, expected] of [['123.45', '123.45'], ['+123.4567', '123.4567'], ['-123', '-123']]) {
        const { ok, value } = tryConvert(text, ColumnType.Decimal);
        assert.equal(ok, true, text);
        assert.equal(value.toString(), expected);
    }
});

test('local notation is rejected', () => {
    for (const text of ['123,45', '1.234,56', '+ 123', '1e5', 'NaN']) {
        assert.equal(tryConvert(text, ColumnType.Decimal).ok, false, text);
    }
});

test('dates may have a time zone', () => {
    for (const text of ['2007-12-25', '2007-12-25+01:00', '2007-12-25Z']) {
        const { ok, value } = tryConvert(text, ColumnType.Date);
        assert.equal(ok, true, text);
        assert.equal(value.toISOString(), '2007-12-25T00:00:00.000Z');
    }

    assert.equal(tryConvert('2007-02-30', ColumnType.Date).ok, false);
});

test('empty text is null for typed columns', () => {
    assert.deepEqual(tryConvert('', ColumnType.Decimal), { ok: true, value: null });
});

test('time ignores the time zone', () => {
    assert.deepEqual(tryConvert('18:30:00+01:00', ColumnType.Time), { ok: true, value: '18:30:00' });
});

test('integers stay exact or fail', () => {
    assert.deepEqual(tryConvert('9007199254740991', ColumnType.Integer), { ok: true, value: 9007199254740991 });
    assert.equal(tryConvert('9007199254740993', ColumnType.Integer).ok, false);
});

test('decimal arithmetic is exact and keeps the scale', () => {
    const sum = Decimal.parse('0.10').add(Decimal.parse('0.2'));
    assert.equal(sum.toString(), '0.30');
    assert.ok(sum.equals(Decimal.parse('0.3')));
    assert.equal(Decimal.parse('79228162514264337593543950336'), null);
});
