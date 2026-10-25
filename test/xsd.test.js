import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auditfile, AuditfileSource, AuditfileVersion } from '../src/index.js';
import { bytes, official, officialText, source } from './test-files.js';

async function xsdErrors(text) {
    const report = await Auditfile.scan(AuditfileSource.fromFactory(() => bytes(text), 'variant.xaf'));
    return report.diagnostics.filter((d) => d.code === 'XAF-D001').map((d) => d.message);
}

test('the official test file is valid against its XSD', async () => {
    const report = await Auditfile.scan(source(official));
    assert.deepEqual(report.diagnostics.filter((d) => d.code.startsWith('XAF-D')), []);
});

test('facets are checked', async () => {
    const errors = await xsdErrors(officialText.replace('<fiscalYear>2016</fiscalYear>', '<fiscalYear>2016-2017-2018</fiscalYear>'));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /maxLength/);
});

test('enumerations are checked', async () => {
    const errors = await xsdErrors(officialText.replace('<curCode>EUR</curCode>', '<curCode>XXX</curCode>'));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /enumeration/);
});

test('the element order of a sequence is checked', async () => {
    const errors = await xsdErrors(officialText.replace(/<startDate>[^<]*<\/startDate>/, ''));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /endDate.*not expected.*startDate/);
});

test('dates must be real dates', async () => {
    const errors = await xsdErrors(officialText.replace('<startDate>2016-01-01</startDate>', '<startDate>2016-02-30</startDate>'));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /xs:date/);
});

test('text in element-only content is refused', async () => {
    const errors = await xsdErrors(officialText.replace('<header>', '<header>text'));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /element-only/);
});

test('identity constraints with prefixed selectors are enforced', () => {
    // XAA 3.2 uses prefixed XPath steps, so its keys select elements; XAF 3.2 does not.
    const set = AuditfileVersion.CashRegister.V3_2.createSchemaSet();
    const root = [...set.elements.values()][0];
    assert.ok(root.constraints.some((c) => c.kind === 'key' && c.selector[0].steps.every((s) => s.startsWith('{http://www.auditfiles.nl/XAA/3.2}'))));
});
