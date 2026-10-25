import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Auditfile, AuditfileSchema, AuditfileSource, Decimal, MemorySink, ReadMode, VersionSource } from '../src/index.js';
import { bytes, official, officialText, source, write } from './test-files.js';

test('reads the official test file', async () => {
    const sink = new MemorySink();
    const report = await Auditfile.read(source(official), sink);

    assert.equal(report.loaded, true);
    assert.equal(report.schema.source, VersionSource.Official);
    assert.equal(report.rowCounts.size, 27);
    assert.ok(new Decimal(314n, 2).equals(sink.rows('tr_line')[0].get('amnt')));
    assert.equal(sink.rows('tr_line')[0].get('eff_date').toISOString(), '1967-08-13T00:00:00.000Z');
});

test('business rules find the unbalanced transaction in the official test file', async () => {
    const report = await Auditfile.validate(source(official));

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-R001'));
    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-R003'));
    assert.equal(report.isValid, false);
});

test('rows know their parent and order', async () => {
    const sink = new MemorySink();
    await Auditfile.read(source(official), sink);

    const transaction = sink.rows('transaction')[0];
    const line = sink.rows('tr_line')[0];
    assert.equal(line.parentId, transaction.id);
    assert.equal(line.ordinal, 1);
    assert.ok(line.id > transaction.id);
});

test('split files read as one audit file', async () => {
    const cut = officialText.indexOf('<transaction>');
    const first = bytes(officialText.slice(0, cut));
    const second = bytes(`<!-- Vervolgbestand 2 van 2 -->\n${officialText.slice(cut)}`);

    const whole = new MemorySink();
    const split = new MemorySink();
    await Auditfile.read(source(official), whole);
    const report = await Auditfile.read(AuditfileSource.fromFactories(['split.xaf', () => first], ['split-2.xaf', () => second]), split);

    assert.equal(report.parts.length, 2);
    assert.deepEqual([...report.rowCounts], [...whole.report.rowCounts]);
    assert.equal(split.rows('tr_line')[0].part, 2);
});

test('single-use stream is validated during load and aborted when invalid', async () => {
    const invalid = officialText.replace('<header>', '<header><vendorExtra>1</vendorExtra>');
    const sink = new MemorySink();

    const report = await Auditfile.read(AuditfileSource.fromStream(bytes(invalid)), sink);

    assert.equal(sink.isAborted, true);
    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-S005'));
    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-D001'));
});

test('unverified mode skips unknown elements with a warning', async () => {
    const path = write('extra.xaf', officialText.replace('<header>', '<header><vendorExtra>1</vendorExtra>'));

    const report = await Auditfile.read(source(path), new MemorySink(), { mode: ReadMode.Unverified });

    assert.equal(report.loaded, true);
    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-S003' && d.path === 'auditfile/header/vendorExtra'));
});

test('scan counts rows and the schema survives JSON', async () => {
    const report = await Auditfile.scan(source(official));
    const json = report.schema.toJson();
    const back = AuditfileSchema.fromJson(json);

    assert.equal(report.schema.hasRowCounts, true);
    assert.equal(report.schema.table('tr_line').rowCount, 1);
    assert.equal(back.toJson(), json);
    assert.notEqual(back.table('tr_line').findColumn('amnt').definition, null);
});

test('parts report size and SHA-256 of the bytes as read', async () => {
    const report = await Auditfile.scan(source(official));
    const data = readFileSync(official);

    assert.equal(report.parts[0].size, data.length);
    assert.equal(report.parts[0].sha256, createHash('sha256').update(data).digest('hex'));
});

test('files in a single-byte encoding are decoded', async () => {
    const text = officialText.replace('encoding="UTF-8"', 'encoding="windows-1252"').replace('<companyName>', '<companyName>Café ');
    const data = Uint8Array.from(text, (c) => c.charCodeAt(0));
    const sink = new MemorySink();

    await Auditfile.read(AuditfileSource.fromFactory(() => data, 'ansi.xaf'), sink);

    assert.ok(sink.rows('company')[0].get('company_name').startsWith('Café '));
});

test('reading rows yourself sees every row', async () => {
    const reader = await Auditfile.open(source(official), { mode: ReadMode.Unverified });
    let lines = 0;
    for await (const row of reader.readRows()) {
        lines += row.table.name === 'tr_line' ? 1 : 0;
    }

    assert.equal(reader.schema.versionKey, 'xaf/3.2');
    assert.equal(lines, 1);
    assert.equal(reader.report.rowCounts.get('tr_line'), 1);
});

test('unknown options are refused', async () => {
    await assert.rejects(() => Auditfile.scan(source(official), { mod: 'unverified' }), TypeError);
});
