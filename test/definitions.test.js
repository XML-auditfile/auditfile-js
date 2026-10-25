import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditfileVersion } from '../src/index.js';
import { VERSION_GROUPS } from '../src/versioning/version.js';

test('every registry entry has a constant and vice versa', () => {
    const constants = VERSION_GROUPS.flatMap((group) => Object.values(AuditfileVersion[group]).map((v) => v.key)).sort();
    const registry = AuditfileVersion.all.map((v) => v.key).sort();
    assert.deepEqual(constants, registry);
});

test('XAF 3.2 manifest has the expected structure', () => {
    const manifest = AuditfileVersion.Financial.V3_2.manifest;
    assert.equal(manifest.tables.length, 31);
    assert.deepEqual(manifest.requiredTables, ['auditfile', 'header', 'company']);
    assert.equal(manifest.findTable('tr_line').parent, 'transaction');
    assert.ok(manifest.findTable('tr_line').references.some((r) => r.table === 'ledger_account'));
});

test('XAF 3.2 XSD matches its checksum and compiles', () => {
    const version = AuditfileVersion.Financial.V3_2;
    assert.equal(AuditfileVersion.sha256(version.openXsd()), version.manifest.xsdSha256);
    assert.equal(version.createSchemaSet().count, 1);
});

test('every version has a manifest and a compiling XSD', () => {
    for (const version of AuditfileVersion.all) {
        assert.ok(version.manifest.tables.length > 0, version.key);
        assert.equal(AuditfileVersion.sha256(version.openXsd()), version.manifest.xsdSha256, version.key);
        assert.ok(version.createSchemaSet().count > 0, version.key);
    }
});

test('definitions have Dutch text and English labels', () => {
    const amount = AuditfileVersion.Financial.V3_2.definitions.get('tr_line.amnt');
    assert.equal(amount.label.english, 'Amount');
    assert.equal(amount.definition.dutch, 'Bedrag in locale valuta.');
});

test('parse rejects unknown versions', () => {
    assert.throws(() => AuditfileVersion.parse('xaf/9.9'), RangeError);
});
