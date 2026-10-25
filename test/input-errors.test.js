import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auditfile, AuditfileSource, DiagnosticSeverity, MemorySink, ReadMode } from '../src/index.js';
import { bytes, sample, sampleText, source } from './test-files.js';

// Bad input never throws: every case ends in a report with a fatal diagnostic.

/** The first bytes of the sample, then a failure like a broken network share. */
function failing(afterBytes) {
    const data = bytes(sampleText);
    return AuditfileSource.fromFactory(() => (async function* () {
        yield data.subarray(0, afterBytes);
        throw new Error('The network path is no longer available.');
    })(), 'failing.xaf');
}

test('a root element after the first megabyte is reported', async () => {
    const root = sampleText.slice(sampleText.indexOf('<auditfile'));
    const data = bytes(`<?xml version="1.0"?><!--${'x'.repeat(1_100_000)}-->${root}`);
    const padded = AuditfileSource.fromFactory(() => data, 'padded.xaf');

    const scan = await Auditfile.scan(padded);
    const read = await Auditfile.read(padded, new MemorySink());

    assert.ok(scan.diagnostics.some((d) => d.code === 'XAF-X002' && d.severity === DiagnosticSeverity.Fatal));
    assert.ok(read.diagnostics.some((d) => d.code === 'XAF-X002'));
    assert.equal(read.loaded, false);
});

for (const xsd of ['<xsd:schema', '<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"><xsd:element name="a" type="xsd:unknown"/></xsd:schema>']) {
    test(`a custom XSD that does not compile is reported (${xsd.slice(0, 30)})`, async () => {
        const report = await Auditfile.read(source(sample), new MemorySink(), { xsd: () => xsd });

        assert.ok(report.diagnostics.some((d) => d.code === 'XAF-X002' && d.message.includes('XSD')), report.diagnostics.join('\n'));
        assert.equal(report.loaded, false);
    });
}

test('a failure while scanning is reported', async () => {
    const report = await Auditfile.scan(failing(2000));

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-X002' && d.message.includes('failing.xaf')), report.diagnostics.join('\n'));
    assert.equal(report.schema, null);
});

test('a failure while loading is reported and the sink aborts', async () => {
    const sink = new MemorySink();

    const report = await Auditfile.read(failing(2000), sink, { mode: ReadMode.Unverified });

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-X002'), report.diagnostics.join('\n'));
    assert.equal(report.loaded, false);
    assert.equal(sink.isAborted, true);
});

test('a factory that is refused access is reported', async () => {
    const report = await Auditfile.scan(AuditfileSource.fromFactory(() => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }, 'locked.xaf'));

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-X002' && d.message.includes('permission denied')));
});

test('reading a single-use source twice is the caller\'s mistake and throws', async () => {
    const once = AuditfileSource.fromStream(bytes(sampleText));
    await Auditfile.scan(once);

    await assert.rejects(() => Auditfile.scan(once), /only be read once/);
});

test('a large file handed over at once is read, whatever its size', async () => {
    const end = sampleText.indexOf('</company>');
    const data = bytes(sampleText.slice(0, end) + ' '.repeat(2_000_000) + sampleText.slice(end));

    const report = await Auditfile.scan(AuditfileSource.fromFactory(() => data, 'large.xaf'));

    assert.equal(report.schema?.versionKey, 'xaf/3.2', report.diagnostics.join('\n'));
});
