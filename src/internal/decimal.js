const PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?$/;

// The range of .NET decimal, so every implementation of the reader accepts the same values.
const MAX_SCALE = 28;
const MAX_COEFFICIENT = 79228162514264337593543950335n;

/**
 * An exact decimal number: a BigInt coefficient and a scale (digits after the point).
 * Amounts are never floating point, so totals and balances are exact.
 * The scale is kept as written: `Decimal.parse('100.00').toString()` is `'100.00'`.
 */
export class Decimal {
    #coefficient;
    #scale;

    /**
     * @param {bigint} coefficient
     * @param {number} [scale]
     */
    constructor(coefficient, scale = 0) {
        if (typeof coefficient !== 'bigint') {
            throw new TypeError('The coefficient of a Decimal must be a bigint.');
        }

        if (!Number.isInteger(scale) || scale < 0) {
            throw new RangeError('The scale of a Decimal must be a non-negative integer.');
        }

        this.#coefficient = coefficient;
        this.#scale = scale;
    }

    /** Zero. */
    static ZERO = new Decimal(0n, 0);

    /**
     * Parses XSD notation: an optional sign, digits and an optional decimal point. No exponent, no grouping.
     * Returns null when the text is not valid or outside the range of a .NET decimal.
     * @param {string} text
     * @returns {Decimal | null}
     */
    static parse(text) {
        const match = PATTERN.exec(text);
        if (match === null) {
            return null;
        }

        const [, sign, whole, fraction = ''] = match;
        if (whole.length === 0 && fraction.length === 0) {
            return null;
        }

        if (fraction.length > MAX_SCALE) {
            return null;
        }

        const digits = (whole + fraction).replace(/^0+/, '');
        if (digits.length > 29) {
            return null;
        }

        const magnitude = digits.length === 0 ? 0n : BigInt(digits);
        if (magnitude > MAX_COEFFICIENT) {
            return null;
        }

        return new Decimal(sign === '-' ? -magnitude : magnitude, fraction.length);
    }

    /**
     * Converts a number, bigint, numeric string or Decimal.
     * @param {Decimal | number | bigint | string} value
     * @returns {Decimal}
     */
    static from(value) {
        if (value instanceof Decimal) {
            return value;
        }

        if (typeof value === 'bigint') {
            return new Decimal(value, 0);
        }

        if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
                throw new RangeError(`${value} is not a finite number.`);
            }

            if (Number.isInteger(value)) {
                if (!Number.isSafeInteger(value)) {
                    throw new RangeError(`${value} is not a safe integer; pass a string or bigint instead.`);
                }

                return new Decimal(BigInt(value), 0);
            }
        }

        if (typeof value === 'number' || typeof value === 'string') {
            const parsed = Decimal.parse(String(value).trim());
            if (parsed !== null) {
                return parsed;
            }
        }

        throw new TypeError(`'${String(value)}' is not a valid decimal.`);
    }

    /** The unscaled value. */
    get coefficient() {
        return this.#coefficient;
    }

    /** Digits after the decimal point. */
    get scale() {
        return this.#scale;
    }

    /** @param {Decimal} other */
    add(other) {
        const scale = Math.max(this.#scale, other.#scale);
        return new Decimal(this.#rescaled(scale) + other.#rescaled(scale), scale);
    }

    /** @param {Decimal} other */
    subtract(other) {
        return this.add(other.negate());
    }

    negate() {
        return new Decimal(-this.#coefficient, this.#scale);
    }

    /**
     * Compares by value: `1.0` equals `1.00`.
     * @param {Decimal} other
     * @returns {-1 | 0 | 1}
     */
    compareTo(other) {
        const scale = Math.max(this.#scale, other.#scale);
        const a = this.#rescaled(scale);
        const b = other.#rescaled(scale);
        return a < b ? -1 : a > b ? 1 : 0;
    }

    /** @param {unknown} other */
    equals(other) {
        return other instanceof Decimal && this.compareTo(other) === 0;
    }

    /** True when the value has no fractional part. */
    get isInteger() {
        return this.#coefficient % 10n ** BigInt(this.#scale) === 0n;
    }

    /** The value with trailing fractional zeros removed: `1.50` becomes `1.5`. */
    normalize() {
        let coefficient = this.#coefficient;
        let scale = this.#scale;
        while (scale > 0 && coefficient % 10n === 0n) {
            coefficient /= 10n;
            scale--;
        }

        return new Decimal(coefficient, scale);
    }

    /** Nearest JavaScript number; may lose precision. */
    toNumber() {
        return Number(this.toString());
    }

    /** Invariant notation with the scale as written, e.g. `-123.40`. */
    toString() {
        const negative = this.#coefficient < 0n;
        const digits = (negative ? -this.#coefficient : this.#coefficient).toString().padStart(this.#scale + 1, '0');
        const whole = digits.slice(0, digits.length - this.#scale);
        const fraction = digits.slice(digits.length - this.#scale);
        return (negative ? '-' : '') + whole + (this.#scale > 0 ? `.${fraction}` : '');
    }

    /** Serializes as a string so no precision is lost. */
    toJSON() {
        return this.toString();
    }

    [Symbol.for('nodejs.util.inspect.custom')]() {
        return `Decimal(${this.toString()})`;
    }

    #rescaled(scale) {
        return this.#coefficient * 10n ** BigInt(scale - this.#scale);
    }
}
