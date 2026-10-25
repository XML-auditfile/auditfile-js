import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auditfile, AuditfileSource, DiagnosticSeverity, MemorySink, ReadMode } from '../src/index.js';
import { bytes, sampleText } from './test-files.js';

// When the reference check stops keeping unresolved values, it says so once (XAF-R017).

/** The sample with extra lines in its first transaction, each referring to a customer that does not exist. */
function withUnknownCustomers(count) {
    const lines = [];
    for (let i = 0; i < count; i++) {
        lines.push(`<trLine><nr>x</nr><accID>1300</accID><docRef>d</docRef><effDate>2025-01-15</effDate><amnt>1.00</amnt><amntTp>D</amntTp><custSupID>U${i}</custSupID></trLine>`);
    }

    const end = sampleText.indexOf('</transaction>');
    return sampleText.slice(0, end) + lines.join('') + sampleText.slice(end);
}

async function read(text) {
    const data = bytes(text);
    // Room for the 100,000 XAF-R003 errors: a full list would leave out the XAF-R017 warning in favour of errors.
    return Auditfile.read(AuditfileSource.fromFactory(() => data, 'references.xaf'), new MemorySink(), { mode: ReadMode.Unverified, maxDiagnostics: 200_000 });
}

test('reaching the pending limit is reported once', async () => {
    const report = await read(withUnknownCustomers(100_001));

    const warnings = report.diagnostics.filter((d) => d.code === 'XAF-R017');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, DiagnosticSeverity.Warning);
    assert.ok(warnings[0].message.includes('tr_line.cust_sup_id'));
    assert.ok(warnings[0].message.includes('100000'));
});

test('below the limit there is no warning', async () => {
    const report = await read(withUnknownCustomers(10));

    assert.ok(!report.diagnostics.some((d) => d.code === 'XAF-R017'));
    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-R003'));
});
