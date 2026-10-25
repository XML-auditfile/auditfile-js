import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auditfile, AuditfileSource, DiagnosticSeverity, MemorySink, ReadMode } from '../src/index.js';
import { bytes, sampleText } from './test-files.js';

// Size limits: a huge value or document is reported, never read into memory as a whole.

const COMPANY_NAME = '<companyName>Bakkerij De Korenschoof B.V.</companyName>';

async function read(text, sink, options) {
    const data = bytes(text);
    return Auditfile.read(AuditfileSource.fromFactory(() => data, 'limits.xaf'), sink, options);
}

test('a value longer than the maximum is skipped with a warning', async () => {
    const sink = new MemorySink();

    const report = await read(sampleText.replace(COMPANY_NAME, `<companyName>${'x'.repeat(70_000)}</companyName>`), sink, { mode: ReadMode.Unverified });

    assert.equal(report.loaded, true);
    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-S008' && d.message.includes('company.company_name')
        && d.message.includes('70000') && d.message.includes('65536')), report.diagnostics.join('\n'));
    assert.equal(sink.rows('company')[0].get('company_name'), null);
});

test('the maximum value length is an option', async () => {
    const sink = new MemorySink();

    const report = await read(sampleText, sink, { maxValueLength: 10 });

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-S008' && d.message.includes('company.company_name')));
    assert.equal(sink.rows('header')[0].get('cur_code'), 'EUR');
});

test('a value of exactly the maximum is kept', async () => {
    const sink = new MemorySink();

    await read(sampleText, sink, { maxValueLength: 'Bakkerij De Korenschoof B.V.'.length });

    assert.equal(sink.rows('company')[0].get('company_name'), 'Bakkerij De Korenschoof B.V.');
});

test('a document larger than the maximum stops', async () => {
    const report = await read(sampleText, new MemorySink(), { maxCharactersInDocument: 5000 });

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-X001' && d.severity === DiagnosticSeverity.Fatal));
    assert.equal(report.loaded, false);
});
