import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auditfile, AuditfileSchema, AuditfileSource, AuditfileVersion, DiagnosticSeverity, MemorySink, ReadMode } from '../src/index.js';
import { bytes, sample, sampleText, source } from './test-files.js';

// The promises of the public API: a truthful report, checked options, cancellation, and no silent surprises.

const unverified = { mode: ReadMode.Unverified };

function fromText(text, name = 'test.xaf') {
    const data = bytes(text);
    return AuditfileSource.fromFactory(() => data, name);
}

/** The sample with unknown elements in the header, each reported once as a warning (XAF-S003). */
function withUnknownElements(count) {
    return sampleText.replace('<header>', `<header>${Array.from({ length: count }, (_, i) => `<unknown${i}/>`).join('')}`);
}

/** The sample cut before the first transaction. */
function split(text) {
    const cut = text.indexOf('<transaction>');
    return [text.slice(0, cut), text.slice(cut)];
}

function parts(first, second) {
    return AuditfileSource.fromFactories(['part-1.xaf', () => first], ['part-2.xaf', () => second]);
}

const latin1 = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function utf16le(text) {
    const result = new Uint8Array(2 + text.length * 2);
    result.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) {
        result[2 + i * 2] = text.charCodeAt(i) & 0xff;
        result[3 + i * 2] = text.charCodeAt(i) >> 8;
    }

    return result;
}

test('errors are counted and kept when the list is full of warnings', async () => {
    const report = await Auditfile.validate(fromText(withUnknownElements(20)), { mode: ReadMode.Unverified, maxDiagnostics: 5 });

    assert.equal(report.isValid, false);
    assert.equal(report.hasErrors, true);
    assert.equal(report.isTruncated, true);
    assert.equal(report.count(DiagnosticSeverity.Error), 2);
    assert.equal(report.count(DiagnosticSeverity.Warning), 20);
    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-R001'));
    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-R003'));
    assert.equal(report.diagnostics.at(-1).code, 'XAF-X900');
    assert.equal(report.diagnostics.length, 6);
});

test('options out of range are refused', async () => {
    for (const options of [{ maxDiagnostics: 0 }, { maxDiagnostics: -1 }, { batchSize: 0 }, { maxDepth: 0 }, { maxValueLength: 0 }, { maxCharactersInDocument: -1 }]) {
        await assert.rejects(() => Auditfile.scan(source(sample), options), RangeError, JSON.stringify(options));
    }
});

test('validate respects unverified mode', async () => {
    const invalid = sampleText.replace('<amnt>327.00</amnt>', '<amnt>abc</amnt>');

    const verified = await Auditfile.validate(fromText(invalid));
    const report = await Auditfile.validate(fromText(invalid), unverified);

    assert.ok(verified.diagnostics.some((d) => d.code === 'XAF-D001'));
    assert.ok(!report.diagnostics.some((d) => d.code === 'XAF-D001'));
    assert.ok(report.diagnostics.some((d) => d.code === 'XAF-S004'));
});

test('rows can be iterated only once', async () => {
    const reader = await Auditfile.open(source(sample), unverified);
    let count = 0;
    for await (const row of reader.readRows()) {
        count += row === null ? 0 : 1;
    }

    assert.ok(count > 0);
    await assert.rejects(async () => {
        for await (const row of reader.readRows()) {
            assert.fail(`unexpected row ${row}`);
        }
    }, /only once/);
    assert.equal(reader.report.rowCounts.get('header'), 1);
});

test('cancellation stops the scan and the load', async () => {
    const signal = AbortSignal.abort();

    await assert.rejects(() => Auditfile.scan(source(sample), { signal }), { name: 'AbortError' });
    await assert.rejects(() => Auditfile.validate(source(sample), { signal }), { name: 'AbortError' });
    await assert.rejects(() => Auditfile.validate(source(sample), { mode: ReadMode.Unverified, signal }), { name: 'AbortError' });
    await assert.rejects(() => Auditfile.open(source(sample), { signal }), { name: 'AbortError' });
});

test('a failing abort does not hide the original error', async () => {
    const sink = {
        capabilities: 0,
        begin() {},
        write() { throw new Error('database gone'); },
        complete() {},
        abort() { throw new Error('rollback failed'); },
    };

    await assert.rejects(() => Auditfile.read(source(sample), sink, { batchSize: 1 }), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors.map((e) => e.message), ['database gone', 'rollback failed']);
        return true;
    });
});

test('an abort that succeeds rethrows the original error', async () => {
    const sink = { capabilities: 0, begin() {}, write() { throw new Error('database gone'); }, complete() {}, abort() {} };

    await assert.rejects(() => Auditfile.read(source(sample), sink, { batchSize: 1 }), { message: 'database gone' });
});

test('a custom XSD factory is called once', async () => {
    let calls = 0;
    const xsd = () => {
        calls++;
        return AuditfileVersion.parse('xaf/3.2').openXsd();
    };

    const report = await Auditfile.validate(source(sample), { xsd });

    assert.equal(calls, 1);
    assert.ok(!report.diagnostics.some((d) => ['XAF-D001', 'XAF-D002', 'XAF-X002'].includes(d.code)), report.diagnostics.join('\n'));
});

test('a missing required field is reported without the XSD', async () => {
    const at = sampleText.indexOf('<amnt>327.00</amnt>', sampleText.indexOf('<trLine>'));
    const missing = sampleText.slice(0, at) + sampleText.slice(at + '<amnt>327.00</amnt>'.length);

    const report = await Auditfile.validate(fromText(missing), unverified);

    const found = report.diagnostics.filter((d) => d.code === 'XAF-S006');
    assert.equal(found.length, 1, report.diagnostics.join('\n'));
    assert.match(found[0].message, /amnt/);
    assert.match(found[0].message, /tr_line/);
});

test('a file with all required fields has no missing fields', async () => {
    const report = await Auditfile.validate(source(sample), unverified);

    assert.ok(!report.diagnostics.some((d) => d.code === 'XAF-S006'), report.diagnostics.join('\n'));
});

test('parts in different encodings are refused', async () => {
    const [first, second] = split(sampleText.replaceAll('Factuur 2025-001', 'Factuur café'));
    const report = await Auditfile.read(
        parts(latin1(first.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"')), bytes(`<?xml version="1.0" encoding="UTF-8"?>${second}`)),
        new MemorySink(), unverified);

    const found = report.diagnostics.filter((d) => d.code === 'XAF-X004');
    assert.equal(found.length, 1, report.diagnostics.join('\n'));
    assert.equal(found[0].severity, DiagnosticSeverity.Fatal);
    assert.equal(found[0].part, 2);
    assert.match(found[0].message, /UTF-8 \(part 1: ISO-8859-1\)/);
    assert.equal(report.loaded, false);
});

for (const [name, encode] of [['ISO-8859-1', latin1], ['UTF-16', utf16le]]) {
    test(`parts in the same encoding are read correctly (${name})`, async () => {
        const [first, second] = split(sampleText.replaceAll('Factuur 2025-001', 'Factuur café').replace('encoding="UTF-8"', `encoding="${name}"`));
        const sink = new MemorySink();

        const report = await Auditfile.read(parts(encode(first), encode(`<?xml version="1.0" encoding="${name}"?>${second}`)), sink, unverified);

        assert.ok(!report.diagnostics.some((d) => d.severity === DiagnosticSeverity.Fatal), report.diagnostics.join('\n'));
        assert.ok(sink.rows('tr_line').some((r) => r.get('desc') === 'Factuur café'));
    });
}

test('a schema in an unknown format is refused', async () => {
    const json = (await Auditfile.scan(source(sample))).schema.toJson();

    assert.equal(AuditfileSchema.fromJson(json).toJson(), json);
    assert.throws(() => AuditfileSchema.fromJson(json.replace('"formatVersion":1', '"formatVersion":2')), SyntaxError);
    assert.throws(() => AuditfileSchema.fromJson(json.replace('"formatVersion":1,', '')), SyntaxError);
    assert.throws(() => AuditfileSchema.fromJson(json.replace('"type":"decimal"', '"type":"money"')), SyntaxError);
    assert.throws(() => AuditfileSchema.fromJson(json.replace('"source":"official"', '"source":"guessed"')), SyntaxError);
});
