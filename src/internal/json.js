// Typed access to parsed JSON. Every accessor checks the type, so malformed input fails with a clear message
// instead of producing undefined values further on.

/** @param {unknown} value */
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string} text
 * @param {string} name
 */
export function parseObject(text, name) {
    let value;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new SyntaxError(`${name} is not valid JSON: ${error.message}`);
    }

    if (!isObject(value)) {
        throw new SyntaxError(`${name} is not a JSON object.`);
    }

    return value;
}

function has(json, key) {
    return Object.prototype.hasOwnProperty.call(json, key) && json[key] !== null && json[key] !== undefined;
}

export function string(json, key) {
    const value = has(json, key) ? json[key] : undefined;
    if (typeof value !== 'string') {
        throw new SyntaxError(`JSON: '${key}' must be a string.`);
    }

    return value;
}

export function optionalString(json, key) {
    return has(json, key) ? string(json, key) : null;
}

export function int(json, key) {
    const value = has(json, key) ? json[key] : undefined;
    if (!Number.isSafeInteger(value)) {
        throw new SyntaxError(`JSON: '${key}' must be an integer.`);
    }

    return value;
}

export function optionalInt(json, key) {
    return has(json, key) ? int(json, key) : null;
}

export function bool(json, key) {
    return has(json, key) && json[key] === true;
}

export function object(json, key) {
    if (!has(json, key)) {
        return null;
    }

    if (!isObject(json[key])) {
        throw new SyntaxError(`JSON: '${key}' must be an object.`);
    }

    return json[key];
}

export function array(json, key) {
    if (!has(json, key)) {
        return [];
    }

    if (!Array.isArray(json[key])) {
        throw new SyntaxError(`JSON: '${key}' must be an array.`);
    }

    return json[key];
}

export function objects(json, key) {
    return array(json, key).map((item) => {
        if (!isObject(item)) {
            throw new SyntaxError(`JSON: '${key}' must contain objects.`);
        }

        return item;
    });
}

export function strings(json, key) {
    return array(json, key).map((item) => {
        if (typeof item !== 'string') {
            throw new SyntaxError(`JSON: '${key}' must contain strings.`);
        }

        return item;
    });
}

export { isObject };
