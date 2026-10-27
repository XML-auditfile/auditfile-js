import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Auditfile, AuditfileSource, AuditfileVersion, MemorySink, ReadMode } from '../src/index.js';
import { bytes, OFFICIAL_NAMESPACE, sampleText } from './test-files.js';

// Dialects and views added at runtime, in the format of auditfile-spec, next to the built-in ones.

const DEVIATING_NAMESPACE = 'http://www.auditfiles.nl/XAF/3.2/';

const DIALECTS = JSON.stringify({
    formatVersion: 1,
    dialects: [{
        name: 'test-package',
        description: { nl: 'Testpakket met afwijkende namespace en decimale komma.', en: 'Test package with a deviating namespace and decimal comma.' },
        match: { namespaces: [DEVIATING_NAMESPACE] },
        corrections: [
            { code: 'XAF-C001', action: 'replaceNamespace', from: DEVIATING_NAMESPACE, to: OFFICIAL_NAMESPACE },
            { code: 'XAF-C002', action: 'decimalComma', paths: ['auditfile/company/transactions/journal/transaction/trLine/amnt'] },
        ],
    }],
});

const VIEWS = JSON.stringify({
    formatVersion: 1,
    type: 'xaf',
    views: [
        {
            name: 'lines_per_account',
            label: { nl: 'Regels per rekening', en: 'Lines per account' },
            source: 'tr_line',
            columns: [
                { name: 'account', value: 'tr_line.acc_id' },
                { name: 'lines', aggregate: 'count' },
            ],
            orderBy: ['account'],
        },
        {
            name: 'needs_unknown_table',
            source: 'no_such_table',
            columns: [{ name: 'value', value: 'no_such_table.value' }],
        },
    ],
});

/** The sample in the deviating namespace, with decimal commas in the amounts of the transaction lines. */
const deviating = sampleText
    .replace(`xmlns="${OFFICIAL_NAMESPACE}"`, `xmlns="${DEVIATING_NAMESPACE}"`)
    .replace(/<trLine>[\s\S]*?<\/trLine>/g, (line) => line.replace(/<amnt>(\d+)\.(\d+)<\/amnt>/, '<amnt>$1,$2</amnt>'));

function fromText(text) {
    const data = bytes(text);
    return AuditfileSource.fromFactory(() => data, 'custom.xaf');
}

async function loadSample() {
    const sink = new MemorySink();
    await Auditfile.read(fromText(sampleText), sink, { mode: ReadMode.Unverified });
    return sink;
}

afterEach(() => {
    Auditfile.dialects.clear();
    Auditfile.views.clear();
});

test('an added view is found and runs like a built-in view', async () => {
    const added = Auditfile.views.add(VIEWS);

    const version = AuditfileVersion.Financial.V3_2;
    assert.deepEqual(added.map((v) => v.name), ['lines_per_account', 'needs_unknown_table']);
    assert.equal(version.findView('lines_per_account'), added[0]);
    assert.ok(version.findView('trial_balance') !== null, 'built-in views stay');
    assert.equal(AuditfileVersion.Financial.V4_0_3.findView('lines_per_account'), added[0], 'shared by all versions of the type');
    assert.equal(AuditfileVersion.Payroll.V2027_1_0.findView('lines_per_account'), null, 'not for another type');

    const sink = await loadSample();
    const result = sink.run(version.findView('lines_per_account'));
    assert.equal(result.isAvailable, true);
    assert.deepEqual(result.diagnostics, []);
    const lines = sink.rows('tr_line');
    assert.equal(result.rows.reduce((sum, row) => sum + row[1], 0), lines.length);
    assert.deepEqual(result.rows.map((r) => r[0]), [...new Set(lines.map((l) => l.getString('acc_id')))].sort());

    const unavailable = sink.run(version.findView('needs_unknown_table'));
    assert.equal(unavailable.isAvailable, false);
    assert.equal(unavailable.diagnostics[0].code, 'XAF-Q001');
});

test('views can be added as a parsed object and removed again', () => {
    Auditfile.views.add(JSON.parse(VIEWS));

    assert.equal(Auditfile.views.remove('xaf', 'lines_per_account'), true);
    assert.equal(Auditfile.views.remove('xaf', 'lines_per_account'), false);
    assert.equal(Auditfile.views.remove('xaf', 'trial_balance'), false, 'built-in views cannot be removed');
    assert.equal(AuditfileVersion.Financial.V3_2.findView('lines_per_account'), null);
    assert.ok(AuditfileVersion.Financial.V3_2.findView('needs_unknown_table') !== null);
});

test('an added dialect is recognized by namespace and corrects values', async () => {
    const before = await Auditfile.validate(fromText(deviating), { mode: ReadMode.Unverified });
    assert.equal(before.diagnostics[0].code, 'XAF-V001', 'unknown without the dialect');

    const [dialect] = Auditfile.dialects.add('xaf/3.2', DIALECTS);
    assert.ok(AuditfileVersion.Financial.V3_2.dialects.includes(dialect));

    const sink = new MemorySink();
    const report = await Auditfile.read(fromText(deviating), sink, { mode: ReadMode.Unverified });

    assert.equal(report.loaded, true, report.diagnostics.join('\n'));
    assert.equal(report.schema.dialect, 'test-package');
    const codes = report.diagnostics.map((d) => d.code);
    for (const code of ['XAF-V002', 'XAF-C001', 'XAF-C002']) {
        assert.ok(codes.includes(code), `${code} in ${codes}`);
    }
    assert.ok(!codes.includes('XAF-S004'), 'every amount is corrected');
    assert.equal(String(sink.rows('tr_line')[0].getDecimal('amnt')), sampleText.match(/<trLine>[\s\S]*?<amnt>([^<]+)<\/amnt>/)[1]);

    const ignored = await Auditfile.validate(fromText(deviating), { mode: ReadMode.Unverified, applyDialects: false });
    assert.equal(ignored.diagnostics[0].code, 'XAF-V001', 'applyDialects: false ignores added dialects too');
});

test('a removed or cleared dialect no longer applies', async () => {
    Auditfile.dialects.add(AuditfileVersion.Financial.V3_2, DIALECTS);
    assert.equal(Auditfile.dialects.remove('xaf/3.2', 'test-package'), true);
    assert.equal(Auditfile.dialects.remove('xaf/3.2', 'test-package'), false);

    Auditfile.dialects.add('xaf/3.2', DIALECTS);
    Auditfile.dialects.clear();

    const report = await Auditfile.validate(fromText(deviating), { mode: ReadMode.Unverified });
    assert.equal(report.diagnostics[0].code, 'XAF-V001');
});

test('invalid files are refused as a whole', () => {
    const views = JSON.parse(VIEWS);
    const dialects = JSON.parse(DIALECTS);
    const withView = (view) => ({ ...views, views: [views.views[0], view] });
    const withCorrection = (correction) => ({ dialects: [{ ...dialects.dialects[0], corrections: [correction] }] });

    assert.throws(() => Auditfile.views.add('{ not json'), SyntaxError);
    assert.throws(() => Auditfile.views.add('[]'), SyntaxError);
    assert.throws(() => Auditfile.views.add(42), TypeError);
    assert.throws(() => Auditfile.views.add({ ...views, formatVersion: 2 }), SyntaxError);
    assert.throws(() => Auditfile.views.add({ views: views.views }), SyntaxError, 'type is required');
    assert.throws(() => Auditfile.views.add({ ...views, type: 'xyz' }), RangeError);
    assert.throws(() => Auditfile.views.add(withView({ name: 'trial_balance', source: 'tr_line' })), RangeError, 'name of a built-in view');
    assert.throws(() => Auditfile.views.add(withView(views.views[0])), RangeError, 'name twice in one file');
    assert.throws(() => Auditfile.views.add(withView({ name: 'x', source: 'tr_line', columns: [{ name: 'a', aggregate: 'median' }] })), SyntaxError);
    assert.equal(AuditfileVersion.Financial.V3_2.findView('lines_per_account'), null, 'nothing of a refused file is added');

    assert.throws(() => Auditfile.dialects.add('xaf/9.9', dialects), RangeError);
    assert.throws(() => Auditfile.dialects.add(null, dialects), TypeError);
    assert.throws(() => Auditfile.dialects.add('xaf/3.2', withCorrection({ code: 'XAF-C002', action: 'guess', paths: [] })), SyntaxError);
    assert.throws(() => Auditfile.dialects.add('xaf/3.2', withCorrection({ code: 'XAF-R001', action: 'decimalComma', paths: [] })), SyntaxError);
    Auditfile.dialects.add('xaf/3.2', dialects);
    assert.throws(() => Auditfile.dialects.add('xaf/3.2', dialects), RangeError, 'name already added');
    assert.equal(AuditfileVersion.Financial.V3_2.dialects.length, 1);
});
