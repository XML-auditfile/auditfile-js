import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auditfile, ReadMode } from '../src/index.js';
import { sampleText, source, write } from './test-files.js';

const discard = { begin() {}, write() {}, complete() {}, abort() {} };

test('document type definitions are refused', async () => {
    const root = sampleText.slice(sampleText.indexOf('<auditfile'));
    const path = write('dtd.xaf', `<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]>${root}`);

    const report = await Auditfile.scan(source(path));

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-X001'));
    assert.equal(report.schema, null);
});

test('entity expansion is refused', async () => {
    const root = sampleText.slice(sampleText.indexOf('<auditfile')).replace('<fiscalYear>2025', '<fiscalYear>&lol;');
    const path = write('lol.xaf', `<?xml version="1.0"?><!DOCTYPE auditfile [<!ENTITY lol "lol">]>${root}`);

    const report = await Auditfile.scan(source(path), { mode: ReadMode.Unverified });

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-X001'));
    assert.equal(report.schema, null);
});

test('truncated files stop with a fatal diagnostic', async () => {
    const path = write('broken.xaf', sampleText.slice(0, sampleText.length / 2));

    const report = await Auditfile.scan(source(path));

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-X001' && d.line > 0));
});

test('excessive nesting is refused', async () => {
    const deep = '<x>'.repeat(100) + '</x>'.repeat(100);
    const path = write('deep.xaf', sampleText.replace('<header>', `<header>${deep}`));

    const report = await Auditfile.scan(source(path), { mode: ReadMode.Unverified });

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-X003'));
});

test('values from the file are never read as replacement patterns', async () => {
    const path = write('amount.xaf', sampleText.replace(/<amnt>[^<]*<\/amnt>/, '<amnt>$$&amp;$$1</amnt>'));

    const report = await Auditfile.read(source(path), discard, { mode: ReadMode.Unverified });

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-S004' && d.message.includes("'$&$1'")), report.diagnostics.join('\n'));
});

test('an unsupported encoding is reported', async () => {
    const path = write('encoding.xaf', sampleText.replace('encoding="UTF-8"', 'encoding="x-unknown-1"'));

    const report = await Auditfile.scan(source(path));

    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-X004'));
});

test('a caller-owned stream is left open when reading stops early', async () => {
    const { Readable } = await import('node:stream');
    const { AuditfileSource } = await import('../src/index.js');
    const stream = new Readable({ read() {} });
    stream.push(new TextEncoder().encode(sampleText.slice(0, 4096)));

    const report = await Auditfile.scan(AuditfileSource.fromStream(stream));

    assert.equal(report.schema.versionKey, 'xaf/3.2');
    assert.equal(stream.destroyed, false);
});
