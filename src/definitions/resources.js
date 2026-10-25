import { files } from '../generated/spec.js';
import { parseObject } from '../internal/json.js';

/** The files from auditfile-spec/generated/ that are embedded in this package (tools/embed-spec.mjs). */

/** @param {string} name */
export function exists(name) {
    return files.has(name);
}

/** @param {string} name */
export function readText(name) {
    const text = files.get(name);
    if (text === undefined) {
        throw new Error(`Embedded definition '${name}' is missing. Was auditfile-spec/generated/ present when the package was built?`);
    }

    return text;
}

/** @param {string} name */
export function readJson(name) {
    return parseObject(readText(name), name);
}

/** The bytes of an embedded file as published. */
export function readBytes(name) {
    return new TextEncoder().encode(readText(name));
}
