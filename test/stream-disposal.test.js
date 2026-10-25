import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Auditfile, AuditfileSource, MemorySink, ReadMode } from '../src/index.js';
import { bytes, OFFICIAL_NAMESPACE, sampleText } from './test-files.js';

// Every stream the reader gets from a factory is closed again, also when reading fails.

const CASES = ['valid', 'unknown namespace', 'dtd', 'truncated', 'root after first megabyte', 'invalid custom xsd', 'io failure'];

function create(name) {
    const root = sampleText.slice(sampleText.indexOf('<auditfile'));
    const content = {
        'unknown namespace': sampleText.replace(`xmlns="${OFFICIAL_NAMESPACE}"`, 'xmlns="urn:unknown"'),
        dtd: `<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]>${root}`,
        truncated: sampleText.slice(0, sampleText.length / 2),
        'root after first megabyte': `<?xml version="1.0"?><!--${'x'.repeat(1_100_000)}-->${root}`,
    }[name] ?? sampleText;
    const data = bytes(content);
    const failAfter = name === 'io failure' ? Math.floor(data.length / 2) : Infinity;
    const tracker = { opened: 0, closed: 0 };
    const source = AuditfileSource.fromFactory(() => {
        tracker.opened++;
        return (async function* () {
            try {
                for (let offset = 0; offset < data.length; offset += 4096) {
                    if (offset >= failAfter) {
                        throw new Error('The network path is no longer available.');
                    }

                    yield data.subarray(offset, offset + 4096);
                }
            } finally {
                tracker.closed++;
            }
        })();
    }, 'tracked.xaf');
    const options = name === 'invalid custom xsd' ? { xsd: () => '<xsd:schema' } : {};
    return { source, tracker, options };
}

for (const name of CASES) {
    test(`read closes every stream: ${name}`, async () => {
        const { source, tracker, options } = create(name);
        await Auditfile.read(source, new MemorySink(), options);
        assert.ok(tracker.opened > 0);
        assert.equal(tracker.closed, tracker.opened);
    });

    test(`unverified read closes every stream: ${name}`, async () => {
        const { source, tracker, options } = create(name);
        await Auditfile.read(source, new MemorySink(), { ...options, mode: ReadMode.Unverified });
        assert.equal(tracker.closed, tracker.opened);
    });

    test(`scan closes every stream: ${name}`, async () => {
        const { source, tracker, options } = create(name);
        await Auditfile.scan(source, options);
        assert.equal(tracker.closed, tracker.opened);
    });
}

test('a failing sink still closes the stream', async () => {
    const { source, tracker } = create('valid');
    const failing = { begin() {}, write() { throw new Error('The database is down.'); }, complete() {}, abort() {} };

    await assert.rejects(() => Auditfile.read(source, failing), /database is down/);

    assert.equal(tracker.closed, tracker.opened);
});

test('stopping early with readRows closes the stream', async () => {
    const { source, tracker } = create('valid');
    const reader = await Auditfile.open(source, { mode: ReadMode.Unverified });

    for await (const _ of reader.readRows()) {
        break;
    }

    assert.equal(tracker.closed, tracker.opened);
});
