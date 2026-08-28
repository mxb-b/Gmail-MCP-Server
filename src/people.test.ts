import { describe, it, expect } from 'vitest';
import {
    sizePhotoUrl,
    personFromApi,
    mergePeopleResults,
    pickPersonByEmail,
    PersonResult,
} from './people.js';

describe('sizePhotoUrl', () => {
    it('appends a size token to a URL that has none', () => {
        expect(sizePhotoUrl('https://lh3.googleusercontent.com/a/ACg8ocABC', 512))
            .toBe('https://lh3.googleusercontent.com/a/ACg8ocABC=s512');
    });

    it('replaces an existing size token', () => {
        expect(sizePhotoUrl('https://lh3.googleusercontent.com/a/ACg8ocABC=s100', 512))
            .toBe('https://lh3.googleusercontent.com/a/ACg8ocABC=s512');
    });

    it('replaces the size token but preserves other options', () => {
        expect(sizePhotoUrl('https://lh3.googleusercontent.com/a/ACg8ocABC=s100-c', 64))
            .toBe('https://lh3.googleusercontent.com/a/ACg8ocABC=s64-c');
    });

    it('keeps multiple non-size options in order', () => {
        expect(sizePhotoUrl('https://lh3.googleusercontent.com/a/ABC=s100-c-k-no', 256))
            .toBe('https://lh3.googleusercontent.com/a/ABC=s256-c-k-no');
    });

    it('adds a size token when the options segment has no size', () => {
        expect(sizePhotoUrl('https://lh3.googleusercontent.com/a/ABC=c', 128))
            .toBe('https://lh3.googleusercontent.com/a/ABC=s128-c');
    });

    it('ignores an "=" that appears before the last path separator', () => {
        expect(sizePhotoUrl('https://lh3.googleusercontent.com/a=b/ABC', 96))
            .toBe('https://lh3.googleusercontent.com/a=b/ABC=s96');
    });

    it('drops a legacy sz query parameter so the size token wins', () => {
        expect(sizePhotoUrl('https://lh3.googleusercontent.com/x/photo.jpg=s100?sz=50', 200))
            .toBe('https://lh3.googleusercontent.com/x/photo.jpg=s200');
    });

    it('preserves query parameters other than sz', () => {
        expect(sizePhotoUrl('https://lh3.googleusercontent.com/x/photo.jpg?token=abc', 200))
            .toBe('https://lh3.googleusercontent.com/x/photo.jpg=s200?token=abc');
    });

    it('floors and clamps the requested size', () => {
        expect(sizePhotoUrl('https://example.com/a/ABC', 128.9)).toBe('https://example.com/a/ABC=s128');
        expect(sizePhotoUrl('https://example.com/a/ABC', 0)).toBe('https://example.com/a/ABC=s1');
        expect(sizePhotoUrl('https://example.com/a/ABC', -20)).toBe('https://example.com/a/ABC=s1');
    });

    it('returns an empty string unchanged', () => {
        expect(sizePhotoUrl('', 512)).toBe('');
    });
});

describe('personFromApi', () => {
    it('maps names, emails, photos and organizations', () => {
        const result = personFromApi({
            resourceName: 'people/123',
            names: [{ displayName: 'Hadeer El-Samaloty', givenName: 'Hadeer', familyName: 'El-Samaloty' }],
            emailAddresses: [{ value: 'elsamalotyh@parkschool.org' }, { value: 'hadeer@example.com' }],
            photos: [{ url: 'https://lh3.googleusercontent.com/a/ABC=s100', default: false }],
            organizations: [{ name: 'The Park School', title: 'HR Manager' }],
        }, 'directory');

        expect(result).toEqual({
            resourceName: 'people/123',
            displayName: 'Hadeer El-Samaloty',
            emails: ['elsamalotyh@parkschool.org', 'hadeer@example.com'],
            photoUrl: 'https://lh3.googleusercontent.com/a/ABC=s100',
            isDefaultPhoto: false,
            organization: 'HR Manager, The Park School',
            source: 'directory',
        });
    });

    it('prefers a non-default photo over a default one regardless of order', () => {
        const result = personFromApi({
            resourceName: 'people/1',
            photos: [
                { url: 'https://example.com/placeholder', default: true },
                { url: 'https://example.com/real', default: false },
            ],
        }, 'contacts');

        expect(result.photoUrl).toBe('https://example.com/real');
        expect(result.isDefaultPhoto).toBe(false);
    });

    it('flags a default-only photo', () => {
        const result = personFromApi({
            resourceName: 'people/1',
            photos: [{ url: 'https://example.com/placeholder', default: true }],
        }, 'contacts');

        expect(result.photoUrl).toBe('https://example.com/placeholder');
        expect(result.isDefaultPhoto).toBe(true);
    });

    it('returns a null photo when the person has none', () => {
        const result = personFromApi({ resourceName: 'people/1' }, 'other');
        expect(result.photoUrl).toBeNull();
        expect(result.isDefaultPhoto).toBe(false);
    });

    it('builds a display name from given and family names when displayName is absent', () => {
        const result = personFromApi({
            resourceName: 'people/2',
            names: [{ givenName: 'Audrey', familyName: 'Johnson' }],
        }, 'contacts');
        expect(result.displayName).toBe('Audrey Johnson');
    });

    it('falls back to the first email when there is no name at all', () => {
        const result = personFromApi({
            resourceName: 'people/3',
            emailAddresses: [{ value: 'nobody@example.com' }],
        }, 'other');
        expect(result.displayName).toBe('nobody@example.com');
    });

    it('trims emails and drops empty ones', () => {
        const result = personFromApi({
            resourceName: 'people/4',
            emailAddresses: [{ value: '  spaced@example.com  ' }, { value: '' }, {}],
        }, 'contacts');
        expect(result.emails).toEqual(['spaced@example.com']);
    });

    it('leaves organization null when none is present', () => {
        expect(personFromApi({ resourceName: 'people/5' }, 'directory').organization).toBeNull();
    });
});

function person(overrides: Partial<PersonResult>): PersonResult {
    return {
        resourceName: 'people/x',
        displayName: 'Someone',
        emails: [],
        photoUrl: null,
        isDefaultPhoto: false,
        organization: null,
        source: 'contacts',
        ...overrides,
    };
}

describe('mergePeopleResults', () => {
    it('de-duplicates by email, case insensitively, keeping the first group', () => {
        const merged = mergePeopleResults([
            [person({ resourceName: 'people/1', emails: ['A@Example.com'], source: 'directory' })],
            [person({ resourceName: 'people/2', emails: ['a@example.com'], source: 'contacts' })],
        ]);

        expect(merged).toHaveLength(1);
        expect(merged[0].resourceName).toBe('people/1');
        expect(merged[0].source).toBe('directory');
    });

    it('unions extra emails from a duplicate without repeating known ones', () => {
        const merged = mergePeopleResults([
            [person({ emails: ['a@example.com'], source: 'directory' })],
            [person({ emails: ['A@EXAMPLE.COM', 'alias@example.com'], source: 'other' })],
        ]);

        expect(merged[0].emails).toEqual(['a@example.com', 'alias@example.com']);
    });

    it('adopts a real photo from a later duplicate when the first has none', () => {
        const merged = mergePeopleResults([
            [person({ emails: ['a@example.com'], source: 'directory' })],
            [person({ emails: ['a@example.com'], photoUrl: 'https://example.com/real', source: 'contacts' })],
        ]);

        expect(merged[0].photoUrl).toBe('https://example.com/real');
        expect(merged[0].source).toBe('directory');
    });

    it('adopts a real photo over a default placeholder', () => {
        const merged = mergePeopleResults([
            [person({ emails: ['a@example.com'], photoUrl: 'https://example.com/ph', isDefaultPhoto: true })],
            [person({ emails: ['a@example.com'], photoUrl: 'https://example.com/real', isDefaultPhoto: false })],
        ]);

        expect(merged[0].photoUrl).toBe('https://example.com/real');
        expect(merged[0].isDefaultPhoto).toBe(false);
    });

    it('does not let a duplicate overwrite an existing real photo', () => {
        const merged = mergePeopleResults([
            [person({ emails: ['a@example.com'], photoUrl: 'https://example.com/first' })],
            [person({ emails: ['a@example.com'], photoUrl: 'https://example.com/second' })],
        ]);

        expect(merged[0].photoUrl).toBe('https://example.com/first');
    });

    it('fills in a missing organization and display name from a duplicate', () => {
        const merged = mergePeopleResults([
            [person({ emails: ['a@example.com'], displayName: '', organization: null })],
            [person({ emails: ['a@example.com'], displayName: 'Real Name', organization: 'Park School' })],
        ]);

        expect(merged[0].displayName).toBe('Real Name');
        expect(merged[0].organization).toBe('Park School');
    });

    it('de-duplicates people with no email by resource name', () => {
        const merged = mergePeopleResults([
            [person({ resourceName: 'people/9', emails: [] })],
            [person({ resourceName: 'people/9', emails: [] })],
            [person({ resourceName: 'people/10', emails: [] })],
        ]);

        expect(merged.map(p => p.resourceName)).toEqual(['people/9', 'people/10']);
    });

    it('preserves group order across sources', () => {
        const merged = mergePeopleResults([
            [person({ emails: ['d@example.com'], source: 'directory' })],
            [person({ emails: ['c@example.com'], source: 'contacts' })],
            [person({ emails: ['o@example.com'], source: 'other' })],
        ]);

        expect(merged.map(p => p.source)).toEqual(['directory', 'contacts', 'other']);
    });

    it('returns an empty list for empty input', () => {
        expect(mergePeopleResults([])).toEqual([]);
        expect(mergePeopleResults([[], []])).toEqual([]);
    });
});

describe('pickPersonByEmail', () => {
    it('prefers an exact email match over a prefix match', () => {
        const picked = pickPersonByEmail([
            person({ emails: ['abbey@example.com'] }),
            person({ resourceName: 'people/match', emails: ['ab@example.com'] }),
        ], 'ab@example.com');

        expect(picked?.resourceName).toBe('people/match');
    });

    it('prefers a person with a real photo among exact matches', () => {
        const picked = pickPersonByEmail([
            person({ resourceName: 'people/nophoto', emails: ['a@example.com'], source: 'directory' }),
            person({ resourceName: 'people/photo', emails: ['a@example.com'], photoUrl: 'https://example.com/p', source: 'contacts' }),
        ], 'a@example.com');

        expect(picked?.resourceName).toBe('people/photo');
    });

    it('prefers the directory source when both candidates have photos', () => {
        const picked = pickPersonByEmail([
            person({ resourceName: 'people/contacts', emails: ['a@example.com'], photoUrl: 'https://example.com/c', source: 'contacts' }),
            person({ resourceName: 'people/directory', emails: ['a@example.com'], photoUrl: 'https://example.com/d', source: 'directory' }),
        ], 'a@example.com');

        expect(picked?.resourceName).toBe('people/directory');
    });

    it('ignores case and surrounding whitespace in the target email', () => {
        const picked = pickPersonByEmail([person({ emails: ['A@Example.com'] })], '  a@example.COM ');
        expect(picked).not.toBeNull();
    });

    it('falls back to the best available result when nothing matches exactly', () => {
        const picked = pickPersonByEmail([person({ emails: ['other@example.com'] })], 'missing@example.com');
        expect(picked?.emails).toEqual(['other@example.com']);
    });

    it('returns null for an empty result list', () => {
        expect(pickPersonByEmail([], 'a@example.com')).toBeNull();
    });
});
