import { OPEN, PartInfo } from '../reading/source.js';
import { Sha256 } from './sha256.js';

const PREFIX_SIZE = 1024;

/** @param {unknown} chunk */
function toBytes(chunk) {
    if (chunk instanceof Uint8Array) {
        return chunk;
    }

    if (chunk instanceof ArrayBuffer) {
        return new Uint8Array(chunk);
    }

    if (ArrayBuffer.isView(chunk)) {
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }

    throw new TypeError('A stream must produce bytes (Uint8Array); text is refused because its encoding is unknown.');
}

async function* single(bytes) {
    yield bytes;
}

async function* fromReader(stream, keepOpen) {
    const reader = stream.getReader();
    let done = false;
    try {
        for (;;) {
            const result = await reader.read();
            if (result.done) {
                done = true;
                return;
            }

            yield result.value;
        }
    } finally {
        if (!done && !keepOpen) {
            await reader.cancel().catch(() => {});
        }

        reader.releaseLock();
    }
}

/**
 * An async iterator over the chunks of any supported stream.
 * With keepOpen the caller's stream is not destroyed when reading stops early.
 * @returns {AsyncIterator<unknown>}
 */
export function iterate(stream, keepOpen) {
    if (stream instanceof Uint8Array || stream instanceof ArrayBuffer || ArrayBuffer.isView(stream)) {
        return single(toBytes(stream));
    }

    if (typeof Blob !== 'undefined' && stream instanceof Blob) {
        return iterate(stream.stream(), false);
    }

    if (stream !== null && typeof stream === 'object') {
        // Node Readable: do not destroy a caller-owned stream.
        if (typeof stream.iterator === 'function' && typeof stream.pipe === 'function') {
            return stream.iterator({ destroyOnReturn: !keepOpen });
        }

        // Web ReadableStream.
        if (typeof stream.getReader === 'function') {
            return fromReader(stream, keepOpen);
        }

        if (typeof stream[Symbol.asyncIterator] === 'function') {
            return stream[Symbol.asyncIterator]();
        }

        if (typeof stream[Symbol.iterator] === 'function') {
            return (async function* () {
                yield* stream;
            })();
        }
    }

    throw new TypeError('Unsupported stream: pass a Readable, ReadableStream, Blob, Uint8Array or an iterable of Uint8Array.');
}

/** Number of bytes of a leading UTF-8 BOM and XML declaration. */
function skipDeclaration(bytes) {
    const length = Math.min(bytes.length, PREFIX_SIZE);
    const position = length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    if (length - position >= 5 && bytes[position] === 0x3c && bytes[position + 1] === 0x3f && bytes[position + 2] === 0x78
        && bytes[position + 3] === 0x6d && bytes[position + 4] === 0x6c) {
        for (let i = position + 5; i < length - 1; i++) {
            if (bytes[i] === 0x3f && bytes[i + 1] === 0x3e) {
                return i + 2;
            }
        }
    }

    return position;
}

/**
 * Reads the parts of a source one after another as one document.
 * For continuation parts a leading byte order mark and XML declaration are skipped.
 * Collects size, SHA-256 and line count per part when collectStatistics is set.
 */
export class ConcatenatedStream {
    #parts;
    /** @type {PartInfo[]} Statistics of the parts read completely so far. */
    completed = [];
    /** Number (1-based) of the part the most recent chunk came from. */
    part = 0;
    /** Bytes handed out so far, over all parts. */
    position = 0;

    /**
     * @param {readonly import('../reading/source.js').SourcePart[]} parts
     * @param {boolean} collectStatistics
     */
    constructor(parts, collectStatistics) {
        this.#parts = parts;
        this.collectStatistics = collectStatistics;
    }

    /** @returns {AsyncGenerator<Uint8Array>} */
    async *chunks() {
        for (const part of this.#parts) {
            this.part = part.number;
            const { stream, keepOpen } = await part[OPEN]();
            const iterator = iterate(stream, keepOpen);
            const statistics = this.collectStatistics ? { hash: Sha256.create(), size: 0, lines: 1, lastWasCarriageReturn: false } : null;
            const track = (bytes) => {
                if (statistics === null) {
                    return;
                }

                statistics.size += bytes.length;
                statistics.hash.update(bytes);
                for (const b of bytes) {
                    if (b === 0x0a) {
                        if (!statistics.lastWasCarriageReturn) {
                            statistics.lines++;
                        }

                        statistics.lastWasCarriageReturn = false;
                    } else if (b === 0x0d) {
                        statistics.lines++;
                        statistics.lastWasCarriageReturn = true;
                    } else {
                        statistics.lastWasCarriageReturn = false;
                    }
                }
            };

            try {
                const prefix = [];
                let prefixLength = 0;
                let done = false;
                while (prefixLength < PREFIX_SIZE) {
                    const result = await iterator.next();
                    if (result.done) {
                        done = true;
                        break;
                    }

                    const bytes = toBytes(result.value);
                    prefix.push(bytes);
                    prefixLength += bytes.length;
                }

                const first = concat(prefix, prefixLength);
                track(first);
                const rest = part.number === 1 ? first : first.subarray(skipDeclaration(first));
                if (rest.length > 0) {
                    this.position += rest.length;
                    yield rest;
                }

                while (!done) {
                    const result = await iterator.next();
                    if (result.done) {
                        break;
                    }

                    const bytes = toBytes(result.value);
                    track(bytes);
                    if (bytes.length > 0) {
                        this.position += bytes.length;
                        yield bytes;
                    }
                }

                if (statistics !== null) {
                    this.completed.push(new PartInfo(part.number, part.name, statistics.size, statistics.hash.digestHex(), statistics.lines));
                }
            } finally {
                await iterator.return?.();
            }
        }
    }
}

function concat(chunks, length) {
    if (chunks.length === 1) {
        return chunks[0];
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }

    return bytes;
}
