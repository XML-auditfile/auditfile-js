import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auditfile, AuditfileVersion, DiagnosticSeverity, MemorySink, VersionSource } from '../src/index.js';
import { source, withNamespace } from './test-files.js';

test('unknown namespace is fatal', async () => {
    const report = await Auditfile.scan(source(withNamespace('urn:example:unknown')));

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-V001' && d.severity === DiagnosticSeverity.Fatal));
    assert.equal(report.schema, null);
});

test('forced version reads an unknown namespace including XSD validation', async () => {
    const report = await Auditfile.read(source(withNamespace('urn:example:unknown')), new MemorySink(), { version: AuditfileVersion.Financial.V3_2 });

    assert.equal(report.loaded, true);
    assert.equal(report.schema.source, VersionSource.Forced);
    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-V003'));
    assert.ok(!report.diagnostics.some((d) => d.code === 'XAF-D001'));
});

test('resolver derives the version from the namespace', async () => {
    const report = await Auditfile.scan(source(withNamespace('http://www.auditfiles.nl/XAF/3.2/')), { useResolver: true });

    assert.equal(report.schema.versionKey, 'xaf/3.2');
    assert.equal(report.schema.source, VersionSource.Resolved);
});

test('resolver is off by default', async () => {
    const report = await Auditfile.scan(source(withNamespace('http://www.auditfiles.nl/XAF/3.2/')));

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-V001'));
});
