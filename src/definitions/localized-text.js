import { optionalString } from '../internal/json.js';

/** Language for definitions and diagnostic messages. */
export const TextLanguage = Object.freeze({
    /** Dutch: the official language of the Belastingdienst publications. */
    Dutch: 'nl',
    /** English; falls back to Dutch where no translation exists. */
    English: 'en',
});

/** A text in Dutch and English. English falls back to Dutch when empty. */
export class LocalizedText {
    /**
     * @param {string | null} dutch
     * @param {string | null} english
     */
    constructor(dutch, english) {
        /** Dutch text, or null. */
        this.dutch = dutch ? dutch : null;
        /** English text, or null. */
        this.english = english ? english : null;
        Object.freeze(this);
    }

    /**
     * The text in the requested language, falling back to the other language.
     * @param {'nl' | 'en'} [language]
     */
    get(language = TextLanguage.Dutch) {
        return language === TextLanguage.English ? this.english ?? this.dutch : this.dutch ?? this.english;
    }

    toString() {
        return this.get(TextLanguage.Dutch) ?? '';
    }

    /** @internal */
    static from(json) {
        return json === null || json === undefined ? null : new LocalizedText(optionalString(json, 'nl'), optionalString(json, 'en'));
    }
}
