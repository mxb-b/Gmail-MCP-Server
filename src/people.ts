/**
 * Google People API helpers: directory and contact lookup plus profile photos.
 *
 * Three sources are consulted, each independently:
 *   - directory: people.searchDirectoryPeople over the Workspace domain profiles
 *     (colleagues), needs the directory.readonly scope.
 *   - contacts:  people.searchContacts over the user's saved contacts, needs
 *     contacts.readonly.
 *   - other:     people.otherContacts.search over the "other contacts" Google
 *     records for addresses the user has emailed, needs contacts.other.readonly.
 *
 * Every source fails soft: a missing scope, a disabled People API, or any other
 * error skips that source and adds a line to the returned warnings array rather
 * than failing the whole call.
 */

import { google, people_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { withTimeout, DEFAULT_TIMEOUT_MS } from './timeout.js';

export type PersonSource = 'directory' | 'contacts' | 'other';

export interface PersonResult {
    resourceName: string;
    displayName: string;
    emails: string[];
    /** Best available photo URL, or null when the person has no photo at all. */
    photoUrl: string | null;
    /** True when photoUrl is Google's generated placeholder rather than a real picture. */
    isDefaultPhoto: boolean;
    /** Primary organization name and title when the source exposed them. */
    organization: string | null;
    source: PersonSource;
}

export interface SearchContactsResult {
    query: string;
    count: number;
    results: PersonResult[];
    warnings: string[];
}

export interface ContactPhotoResult {
    email: string;
    displayName: string;
    photoUrl: string;
    isDefaultPhoto: boolean;
    mimeType?: string;
    contentBase64?: string;
    source: PersonSource;
    warnings: string[];
}

// searchContacts and otherContacts.search cap pageSize at 30; searchDirectoryPeople allows 500.
const CONTACT_SEARCH_MAX_PAGE_SIZE = 30;
const DIRECTORY_SEARCH_MAX_PAGE_SIZE = 500;

// Photo bytes are tiny in practice; this only guards against a pathological URL.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const DIRECTORY_READ_MASK = 'names,emailAddresses,photos,organizations';
const CONTACTS_READ_MASK = 'names,emailAddresses,photos,organizations';
// otherContacts.search accepts only emailAddresses, metadata, names and phoneNumbers.
const OTHER_CONTACTS_READ_MASK = 'names,emailAddresses';

/**
 * Rewrites a People API photo URL to request a specific pixel size.
 *
 * Google photo URLs carry their options in an "=" segment after the last path
 * component, for example ".../AAA=s100-c". An existing s<number> token is
 * replaced and any other options (crop, no-border, and so on) are preserved.
 * A URL with no options segment simply gets "=s<size>" appended. Any legacy
 * "?sz=" query parameter is dropped so the "=s" token is the only size hint.
 */
export function sizePhotoUrl(url: string, size: number): string {
    if (!url) return url;

    const normalizedSize = Math.max(1, Math.floor(size));
    const queryStart = url.indexOf('?');
    const path = queryStart === -1 ? url : url.slice(0, queryStart);
    const rawQuery = queryStart === -1 ? '' : url.slice(queryStart + 1);

    const lastSlash = path.lastIndexOf('/');
    const lastEquals = path.lastIndexOf('=');

    let sizedPath: string;
    if (lastEquals > lastSlash) {
        const base = path.slice(0, lastEquals);
        const otherOptions = path
            .slice(lastEquals + 1)
            .split('-')
            .filter(option => option.length > 0 && !/^s\d+$/i.test(option));
        sizedPath = `${base}=${[`s${normalizedSize}`, ...otherOptions].join('-')}`;
    } else {
        sizedPath = `${path}=s${normalizedSize}`;
    }

    const keptQuery = rawQuery
        .split('&')
        .filter(param => param.length > 0 && !/^sz=/i.test(param))
        .join('&');

    return keptQuery ? `${sizedPath}?${keptQuery}` : sizedPath;
}

/** Normalizes one People API Person into the flat shape the tools return. */
export function personFromApi(person: people_v1.Schema$Person, source: PersonSource): PersonResult {
    const emails = (person.emailAddresses || [])
        .map(entry => (entry.value || '').trim())
        .filter(value => value.length > 0);

    const names = person.names || [];
    const displayName =
        names.find(name => name.displayName)?.displayName ||
        [names[0]?.givenName, names[0]?.familyName].filter(Boolean).join(' ') ||
        emails[0] ||
        '';

    const photos = (person.photos || []).filter(photo => !!photo.url);
    const chosenPhoto = photos.find(photo => photo.default !== true) || photos[0] || null;

    const organizations = person.organizations || [];
    const primaryOrg = organizations.find(org => org.name || org.title) || null;
    const organization = primaryOrg
        ? [primaryOrg.title, primaryOrg.name].filter(Boolean).join(', ') || null
        : null;

    return {
        resourceName: person.resourceName || '',
        displayName,
        emails,
        photoUrl: chosenPhoto?.url || null,
        isDefaultPhoto: chosenPhoto ? chosenPhoto.default === true : false,
        organization,
        source,
    };
}

/** Dedupe key for a person: their first email, lowercased, or the resource name. */
function dedupeKey(person: PersonResult): string {
    if (person.emails.length > 0) return person.emails[0].toLowerCase();
    return person.resourceName || person.displayName.toLowerCase();
}

/**
 * Merges result groups in priority order (pass directory first), keeping the
 * first record for each person. Emails from later duplicates are unioned in,
 * and a real photo from a later duplicate fills in for a missing or default one.
 */
export function mergePeopleResults(groups: PersonResult[][]): PersonResult[] {
    const byKey = new Map<string, PersonResult>();
    const order: string[] = [];

    for (const group of groups) {
        for (const candidate of group) {
            const key = dedupeKey(candidate);
            const existing = byKey.get(key);
            if (!existing) {
                byKey.set(key, { ...candidate, emails: [...candidate.emails] });
                order.push(key);
                continue;
            }

            for (const email of candidate.emails) {
                if (!existing.emails.some(known => known.toLowerCase() === email.toLowerCase())) {
                    existing.emails.push(email);
                }
            }
            const existingPhotoIsUsable = !!existing.photoUrl && !existing.isDefaultPhoto;
            const candidatePhotoIsUsable = !!candidate.photoUrl && !candidate.isDefaultPhoto;
            if (!existingPhotoIsUsable && candidatePhotoIsUsable) {
                existing.photoUrl = candidate.photoUrl;
                existing.isDefaultPhoto = candidate.isDefaultPhoto;
            }
            if (!existing.organization && candidate.organization) {
                existing.organization = candidate.organization;
            }
            if (!existing.displayName && candidate.displayName) {
                existing.displayName = candidate.displayName;
            }
        }
    }

    return order.map(key => byKey.get(key)!).filter(Boolean);
}

function describeError(error: any): string {
    const apiMessage = error?.errors?.[0]?.message || error?.response?.data?.error?.message;
    return apiMessage || error?.message || String(error);
}

// searchContacts and otherContacts.search require a warm-up request with an empty
// query before their first real search, otherwise the cache they read from is not
// populated and the first search comes back empty. Warm up once per process.
let contactsWarmedUp = false;
let otherContactsWarmedUp = false;

async function warmUpContacts(people: people_v1.People): Promise<void> {
    if (contactsWarmedUp) return;
    contactsWarmedUp = true;
    await withTimeout(
        people.people.searchContacts({ query: '', readMask: CONTACTS_READ_MASK, pageSize: 1 }),
        DEFAULT_TIMEOUT_MS,
        'people.searchContacts warm-up'
    );
}

async function warmUpOtherContacts(people: people_v1.People): Promise<void> {
    if (otherContactsWarmedUp) return;
    otherContactsWarmedUp = true;
    await withTimeout(
        people.otherContacts.search({ query: '', readMask: OTHER_CONTACTS_READ_MASK, pageSize: 1 }),
        DEFAULT_TIMEOUT_MS,
        'people.otherContacts.search warm-up'
    );
}

/** Resets the warm-up flags. Exported for tests only. */
export function resetWarmUpState(): void {
    contactsWarmedUp = false;
    otherContactsWarmedUp = false;
}

function peopleClient(auth: OAuth2Client): people_v1.People {
    return google.people({ version: 'v1', auth });
}

export interface SearchContactsArgs {
    query: string;
    maxResults?: number;
}

/**
 * Searches the Workspace directory, saved contacts, and other contacts for a
 * person, returning one de-duplicated list plus a warning per skipped source.
 */
export async function searchContacts(
    auth: OAuth2Client,
    args: SearchContactsArgs
): Promise<SearchContactsResult> {
    const people = peopleClient(auth);
    const query = args.query.trim();
    const maxResults = Math.max(1, Math.floor(args.maxResults ?? 10));
    const warnings: string[] = [];

    let directory: PersonResult[] = [];
    try {
        const response = await withTimeout(
            people.people.searchDirectoryPeople({
                query,
                readMask: DIRECTORY_READ_MASK,
                sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
                pageSize: Math.min(maxResults, DIRECTORY_SEARCH_MAX_PAGE_SIZE),
            }),
            DEFAULT_TIMEOUT_MS,
            'people.searchDirectoryPeople'
        );
        directory = (response.data.people || []).map(person => personFromApi(person, 'directory'));
    } catch (error: any) {
        warnings.push(`directory search skipped: ${describeError(error)}`);
    }

    let contacts: PersonResult[] = [];
    try {
        await warmUpContacts(people);
        const response = await withTimeout(
            people.people.searchContacts({
                query,
                readMask: CONTACTS_READ_MASK,
                pageSize: Math.min(maxResults, CONTACT_SEARCH_MAX_PAGE_SIZE),
            }),
            DEFAULT_TIMEOUT_MS,
            'people.searchContacts'
        );
        contacts = (response.data.results || [])
            .map(result => result.person)
            .filter((person): person is people_v1.Schema$Person => !!person)
            .map(person => personFromApi(person, 'contacts'));
    } catch (error: any) {
        warnings.push(`saved contacts search skipped: ${describeError(error)}`);
    }

    let otherContacts: PersonResult[] = [];
    try {
        await warmUpOtherContacts(people);
        const response = await withTimeout(
            people.otherContacts.search({
                query,
                readMask: OTHER_CONTACTS_READ_MASK,
                pageSize: Math.min(maxResults, CONTACT_SEARCH_MAX_PAGE_SIZE),
            }),
            DEFAULT_TIMEOUT_MS,
            'people.otherContacts.search'
        );
        otherContacts = (response.data.results || [])
            .map(result => result.person)
            .filter((person): person is people_v1.Schema$Person => !!person)
            .map(person => personFromApi(person, 'other'));
    } catch (error: any) {
        warnings.push(`other contacts search skipped: ${describeError(error)}`);
    }

    const merged = mergePeopleResults([directory, contacts, otherContacts]).slice(0, maxResults);

    return { query, count: merged.length, results: merged, warnings };
}

export interface GetContactPhotoArgs {
    email: string;
    size?: number;
    mode?: 'url' | 'base64';
}

/** Picks the best match for an email address out of a merged search result list. */
export function pickPersonByEmail(results: PersonResult[], email: string): PersonResult | null {
    const target = email.trim().toLowerCase();
    const exact = results.filter(person =>
        person.emails.some(candidate => candidate.toLowerCase() === target)
    );
    const pool = exact.length > 0 ? exact : results;
    if (pool.length === 0) return null;

    const order: PersonSource[] = ['directory', 'contacts', 'other'];
    const withPhoto = pool.filter(person => person.photoUrl && !person.isDefaultPhoto);
    const ranked = (withPhoto.length > 0 ? withPhoto : pool)
        .slice()
        .sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
    return ranked[0];
}

/**
 * Finds a person by email address and returns their profile photo, either as a
 * sized URL or with the bytes fetched server-side and base64 encoded.
 */
export async function getContactPhoto(
    auth: OAuth2Client,
    args: GetContactPhotoArgs
): Promise<ContactPhotoResult> {
    const size = Math.max(1, Math.floor(args.size ?? 512));
    const mode = args.mode ?? 'url';
    const email = args.email.trim();

    const search = await searchContacts(auth, { query: email, maxResults: 10 });
    const person = pickPersonByEmail(search.results, email);

    if (!person) {
        throw new Error(
            `No person found for "${email}" in the Workspace directory, saved contacts, or other contacts.` +
            (search.warnings.length > 0 ? ` Sources skipped: ${search.warnings.join('; ')}` : '')
        );
    }

    if (!person.photoUrl) {
        throw new Error(`${person.displayName || email} has no profile photo in Google.`);
    }

    if (person.isDefaultPhoto) {
        throw new Error(
            `${person.displayName || email} has only Google's default placeholder avatar, not a real profile photo.`
        );
    }

    const photoUrl = sizePhotoUrl(person.photoUrl, size);

    if (mode === 'url') {
        return {
            email,
            displayName: person.displayName,
            photoUrl,
            isDefaultPhoto: person.isDefaultPhoto,
            source: person.source,
            warnings: search.warnings,
        };
    }

    const response = await withTimeout(fetch(photoUrl), DEFAULT_TIMEOUT_MS, 'fetch contact photo');
    if (!response.ok) {
        throw new Error(`Failed to fetch photo for ${email}: HTTP ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_PHOTO_BYTES) {
        throw new Error(
            `Photo for ${email} is ${buffer.length} bytes, over the ${MAX_PHOTO_BYTES} byte inline limit. Use mode='url' or a smaller size.`
        );
    }

    return {
        email,
        displayName: person.displayName,
        photoUrl,
        isDefaultPhoto: person.isDefaultPhoto,
        mimeType: response.headers.get('content-type') || 'image/jpeg',
        contentBase64: buffer.toString('base64'),
        source: person.source,
        warnings: search.warnings,
    };
}
