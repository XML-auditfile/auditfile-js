import { SaxesParser } from 'saxes';

/** Event kinds. */
export const START = 1;
export const END = 2;
export const TEXT = 3;

/** The document is not well-formed XML, or its bytes cannot be decoded. */
export class XmlSyntaxError extends Error {
    constructor(message, line, column, part) {
        super(message);
        this.name = 'XmlSyntaxError';
        this.line = line;
        this.column = column;
        this.part = part;
    }
}

/** The declared encoding is not supported. */
export class XmlEncodingError extends Error {
    constructor(encoding) {
        super(`Encoding '${encoding}' is not supported.`);
        this.name = 'XmlEncodingError';
        this.encoding = encoding;
    }
}

/** Determines the encoding from the byte order mark or the XML declaration. */
function detectEncoding(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return 'utf-16le';
    }

    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return 'utf-16be';
    }

    if (bytes.length >= 4 && bytes[0] === 0x3c && bytes[1] === 0x00 && bytes[2] === 0x3f && bytes[3] === 0x00) {
        return 'utf-16le';
    }

    if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x3c && bytes[2] === 0x00 && bytes[3] === 0x3f) {
        return 'utf-16be';
    }

    const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    const head = String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + 512)));
    const declaration = /^<\?xml\s[^>]*?encoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/.exec(head);
    return declaration === null ? 'utf-8' : declaration[2];
}

function createDecoder(encoding) {
    try {
        return new TextDecoder(encoding, { fatal: true });
    } catch {
        throw new XmlEncodingError(encoding);
    }
}

/**
 * Pull reader over a byte stream: start, text and end events with line, column, depth and source part.
 * DTDs are refused, entities other than the five predefined ones are errors, and namespaces are resolved.
 */
export class XmlReader {
    #stream;
    #chunks;
    #parser;
    #decoder = null;
    #queue = [];
    #head = 0;
    #depth = 0;
    #ended = false;
    #pendingText = null;
    #tagLine = 1;
    #tagColumn = 1;
    #mapFrom = null;
    #mapTo = null;

    /** @param {import('./streams.js').ConcatenatedStream} stream */
    constructor(stream) {
        this.#stream = stream;
        this.#chunks = stream.chunks();
        const parser = new SaxesParser({ xmlns: true, position: true, forceXMLVersion: true, defaultXMLVersion: '1.0' });
        this.#parser = parser;

        parser.on('error', (error) => {
            throw new XmlSyntaxError(error.message.replace(/^\d+:\d+: /, ''), parser.line, parser.column + 1, this.#stream.part);
        });
        parser.on('doctype', () => {
            throw new XmlSyntaxError('For security reasons DTD is prohibited in this XML document.', parser.line, parser.column + 1, this.#stream.part);
        });
        parser.on('opentagstart', (tag) => {
            this.#flushText();
            // The parser stands after the name; report the position of the name itself (1-based), as .NET does.
            this.#tagLine = parser.line;
            this.#tagColumn = Math.max(1, parser.column - tag.name.length + 1);
        });
        parser.on('opentag', (tag) => {
            const attributes = [];
            for (const attribute of Object.values(tag.attributes)) {
                attributes.push({ ns: attribute.uri, local: attribute.local, prefix: attribute.prefix, value: attribute.value });
            }

            this.#queue.push({
                kind: START, ns: tag.uri, local: tag.local, prefix: tag.prefix, attributes,
                line: this.#tagLine, column: this.#tagColumn, depth: this.#depth, part: this.#stream.part,
            });
            this.#depth++;
        });
        parser.on('closetag', (tag) => {
            this.#flushText();
            this.#depth--;
            this.#queue.push({ kind: END, ns: tag.uri, local: tag.local, line: parser.line, column: parser.column, depth: this.#depth, part: this.#stream.part });
        });
        const text = (value) => {
            if (this.#pendingText === null) {
                this.#pendingText = { kind: TEXT, text: value, line: parser.line, column: parser.column, part: this.#stream.part };
            } else {
                this.#pendingText.text += value;
            }
        };
        parser.on('text', text);
        parser.on('cdata', text);
    }

    /** Bytes handed to the parser so far. */
    get position() {
        return this.#stream.position;
    }

    /** The source part being parsed. */
    get part() {
        return this.#stream.part;
    }

    /** Presents one namespace as another, e.g. an alias as the official namespace. */
    mapNamespace(from, to) {
        this.#mapFrom = from;
        this.#mapTo = to;
    }

    /**
     * The next event when one is already parsed; undefined when the caller must await {@link XmlReader#next}.
     * Saves a promise per event, which is most of the cost of a large file.
     */
    poll() {
        if (this.#head >= this.#queue.length) {
            return undefined;
        }

        const event = this.#queue[this.#head];
        this.#queue[this.#head++] = undefined;
        return this.#map(event);
    }

    /**
     * The next event, or null at the end of the document.
     * @throws {XmlSyntaxError | XmlEncodingError}
     */
    async next() {
        while (this.#head >= this.#queue.length) {
            this.#queue.length = 0;
            this.#head = 0;
            if (this.#ended) {
                return null;
            }

            await this.#feed();
        }

        const event = this.#queue[this.#head];
        this.#queue[this.#head++] = undefined;
        return this.#map(event);
    }

    /** Puts an event back so the next call returns it again. */
    pushBack(event) {
        if (this.#head > 0) {
            this.#queue[--this.#head] = event;
        } else {
            this.#queue.unshift(event);
        }
    }

    /** Stops reading and closes the streams it opened. */
    async close() {
        this.#ended = true;
        await this.#chunks.return();
    }

    async #feed() {
        let result;
        try {
            result = await this.#chunks.next();
        } catch (error) {
            this.#ended = true;
            throw error;
        }

        try {
            if (result.done) {
                this.#ended = true;
                if (this.#decoder !== null) {
                    this.#write(this.#decoder.decode());
                }

                this.#parser.close();
                this.#flushText();
                return;
            }

            this.#decoder ??= createDecoder(detectEncoding(result.value));
            this.#write(this.#decoder.decode(result.value, { stream: true }));
        } catch (error) {
            this.#ended = true;
            if (error instanceof TypeError && /decode|encoded data/i.test(error.message)) {
                throw new XmlSyntaxError(`Invalid byte sequence for the encoding: ${error.message}`, this.#parser.line, this.#parser.column + 1, this.#stream.part);
            }

            throw error;
        }
    }

    #write(text) {
        if (text.length > 0) {
            this.#parser.write(text);
        }
    }

    #flushText() {
        if (this.#pendingText !== null) {
            this.#queue.push(this.#pendingText);
            this.#pendingText = null;
        }
    }

    #map(event) {
        if (this.#mapFrom === null || event.kind === TEXT) {
            return event;
        }

        const ns = event.ns === this.#mapFrom ? this.#mapTo : event.ns;
        const attributes = event.kind === START && event.attributes.some((a) => a.ns === this.#mapFrom)
            ? event.attributes.map((a) => (a.ns === this.#mapFrom ? { ...a, ns: this.#mapTo } : a))
            : event.attributes;
        return ns === event.ns && attributes === event.attributes ? event : { ...event, ns, attributes };
    }
}
