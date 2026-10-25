import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Sha256 } from '../src/internal/sha256.js';
import { translatePattern } from '../src/xsd/regex.js';

test('SHA-256 matches node:crypto across block boundaries', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
        const data = new Uint8Array(length).map((_, i) => (i * 31 + 7) & 0xff);
        const incremental = new Sha256();
        for (let i = 0; i < data.length; i += 37) {
            incremental.update(data.subarray(i, i + 37));
        }

        const expected = createHash('sha256').update(data).digest('hex');
        assert.equal(new Sha256().update(data).digestHex(), expected, `length ${length}`);
        assert.equal(incremental.digestHex(), expected, `incremental length ${length}`);
    }
});

test('XSD patterns are anchored and literal where XSD is literal', () => {
    assert.equal(translatePattern('\\d{4}|(\\d{4}\\-\\d{4})').test('2008-2009'), true);
    assert.equal(translatePattern('\\d{4}|(\\d{4}\\-\\d{4})').test('x2008'), false);
    assert.equal(translatePattern('[\\-+]?[0-9]{1,3}[.][0-9]{6}').test('-12.123456'), true);
    assert.equal(translatePattern('a$').test('a$'), true);
    assert.throws(() => translatePattern('[a-z-[aeiou]]'));
    assert.throws(() => translatePattern('\\w+'));
});
