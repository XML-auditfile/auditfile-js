/**
 * The encoding of a document or part, from its byte order mark or XML declaration (UTF-8 when neither says otherwise),
 * following the detection rules of XML 1.0 appendix F.
 */
export class PartEncoding {
    /** @internal */
    constructor(name, bomLength, unitSize, bigEndian) {
        /** Name as declared, e.g. "utf-8", "utf-16le", "ISO-8859-1". */
        this.name = name;
        this.bomLength = bomLength;
        /** Bytes per code unit: 1 for UTF-8 and single-byte encodings, 2 for UTF-16. */
        this.unitSize = unitSize;
        this.bigEndian = bigEndian;
        Object.freeze(this);
    }

    /** Upper-case name for messages, e.g. "UTF-8". */
    get label() {
        return this.name.toUpperCase();
    }

    /** True when both decode the same way; labels such as "latin1" and "ISO-8859-1" are the same encoding. */
    sameAs(other) {
        return canonical(this.name) === canonical(other.name);
    }

    /**
     * @param {Uint8Array} bytes The first bytes.
     * @returns {PartEncoding}
     */
    static detect(bytes) {
        const startsWith = (...start) => bytes.length >= start.length && start.every((b, i) => bytes[i] === b);
        if (startsWith(0xef, 0xbb, 0xbf)) {
            return new PartEncoding('utf-8', 3, 1, false);
        }

        if (startsWith(0xff, 0xfe) || startsWith(0x3c, 0x00, 0x3f, 0x00)) {
            return new PartEncoding('utf-16le', startsWith(0xff, 0xfe) ? 2 : 0, 2, false);
        }

        if (startsWith(0xfe, 0xff) || startsWith(0x00, 0x3c, 0x00, 0x3f)) {
            return new PartEncoding('utf-16be', startsWith(0xfe, 0xff) ? 2 : 0, 2, true);
        }

        const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 512)));
        const declaration = /^<\?xml\s[^>]*?encoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/.exec(head);
        return new PartEncoding(declaration === null ? 'utf-8' : declaration[2], 0, 1, false);
    }

    /**
     * Number of bytes of a leading byte order mark and XML declaration.
     * @param {Uint8Array} bytes
     * @param {number} length Bytes to look at.
     */
    skipDeclaration(bytes, length) {
        const position = this.bomLength;
        if (!this.#matches(bytes, length, position, '<?xml')) {
            return position;
        }

        for (let i = position + 5 * this.unitSize; i + 2 * this.unitSize <= length; i += this.unitSize) {
            if (this.#matches(bytes, length, i, '?>')) {
                return i + 2 * this.unitSize;
            }
        }

        return position;
    }

    #matches(bytes, length, position, text) {
        for (let c = 0; c < text.length; c++) {
            const at = position + c * this.unitSize;
            if (at + this.unitSize > length) {
                return false;
            }

            const low = this.unitSize === 1 || !this.bigEndian ? bytes[at] : bytes[at + 1];
            const high = this.unitSize === 1 ? 0 : this.bigEndian ? bytes[at] : bytes[at + 1];
            if (low !== text.charCodeAt(c) || high !== 0) {
                return false;
            }
        }

        return true;
    }
}

/** The WHATWG name of an encoding label, or the label itself when no decoder knows it. */
function canonical(name) {
    try {
        return new TextDecoder(name).encoding;
    } catch {
        return name.toLowerCase();
    }
}

/** The declared encoding is not supported (XAF-X004). */
export class XmlEncodingError extends Error {
    constructor(encoding, message = `Encoding '${encoding}' is not supported.`) {
        super(message);
        this.name = 'XmlEncodingError';
        this.encoding = encoding;
        /** @type {number | null} The part, when one part differs from the first. */
        this.part = null;
    }
}

/**
 * A continuation part in another encoding than the first part. The parts are decoded as one document,
 * so it would be read as garbled text without any error; it is refused instead (XAF-X004).
 */
export class PartEncodingError extends XmlEncodingError {
    constructor(part, encoding, first) {
        super(`${encoding.label} (part 1: ${first.label})`, `Part ${part} is encoded as ${encoding.label}, but part 1 as ${first.label}.`);
        this.name = 'PartEncodingError';
        this.part = part;
    }
}
