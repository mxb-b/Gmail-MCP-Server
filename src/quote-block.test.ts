/**
 * Regression tests for mangled reply quote blocks (2026-09-04).
 *
 * Three defects shipped together in the auto-quote path:
 *  1. index.ts fell back to `html.replace(/<[^>]+>/g, '')` when the previous
 *     message had no text/plain part. Line breaks vanished and &nbsp; / &lt; /
 *     &gt; leaked into the quote as literal text.
 *  2. The "last message in the thread" was taken raw from threads.get, which
 *     also returns DRAFT and TRASH messages, so a draft could be quoted into a
 *     real reply and become its In-Reply-To target.
 *  3. The HTML alternative was only quoted when the caller supplied htmlBody,
 *     so plain-text callers got escaped "&gt;" lines instead of a gmail_quote.
 */

import { describe, it, expect } from 'vitest';
import {
    htmlToPlainText,
    buildHtmlQuote,
    buildPlainTextQuote,
    unwrapHtmlDocument,
    pickQuotableMessage,
} from './utl.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('htmlToPlainText on real HTML-only sender output', () => {
    // Reduced from the Apple Mail message quoted into
    // "Re: Private music lessons for Jasper for next year" on 2026-09-04.
    const appleMailHtml =
        '<html><head><style>p { margin: 0; }</style></head><body>' +
        'Any options of 7:30 am before school?&nbsp;Thank you!!<div>Erika</div>' +
        '<div><br></div>' +
        '<div>On Sep 1, 2026, at 12:27 PM, Jordan Burnham-Bialik ' +
        '&lt;burnham-bialikj@parkschool.org&gt; wrote:</div>' +
        '<div>All the best,<br>Jordan Burnham-Bialik<br>they/them<br>' +
        'Director of Enrichment &amp; Drama Teacher<br>The Park School</div>' +
        '</body></html>';

    const text = htmlToPlainText(appleMailHtml);

    it('leaves no raw HTML entities in the quote', () => {
        expect(text).not.toMatch(/&nbsp;|&lt;|&gt;|&amp;|&quot;/);
    });

    it('decodes entities to the characters the sender wrote', () => {
        expect(text).toContain('<burnham-bialikj@parkschool.org>');
        expect(text).toContain('Director of Enrichment & Drama Teacher');
    });

    it('keeps the line breaks instead of running the signature together', () => {
        // The bug produced "Jordan Burnham-Bialikthey/themDirector of ...".
        expect(text).not.toContain('Burnham-Bialikthey/them');
        expect(text).toContain('Jordan Burnham-Bialik\nthey/them');
    });

    it('drops <style> content rather than leaking CSS into the quote', () => {
        expect(text).not.toContain('margin: 0');
    });

    it('does not double-decode &amp;lt; into a bare "<"', () => {
        // &amp;lt; is the sender writing the literal text "&lt;".
        expect(htmlToPlainText('<div>&amp;lt;tag&amp;gt;</div>')).toBe('&lt;tag&gt;');
    });

    it('decodes numeric entities', () => {
        expect(htmlToPlainText('<p>it&#39;s &#x2014; fine</p>')).toBe("it's — fine");
    });
});

describe('pickQuotableMessage', () => {
    const real = (id: string) => ({ id, labelIds: ['SENT'] });
    const draft = (id: string) => ({ id, labelIds: ['DRAFT'] });
    const trashedDraft = (id: string) => ({ id, labelIds: ['DRAFT', 'TRASH'] });
    const trashed = (id: string) => ({ id, labelIds: ['TRASH'] });

    it('skips a draft sitting at the end of the thread', () => {
        // The 2026-09-04 symptom: "ZZ trash-test draft A (delete me)" was quoted
        // into a reply sent to a parent on thread 1a06d0ef1520eb9c.
        expect(pickQuotableMessage([real('a'), real('b'), draft('zz')])?.id).toBe('b');
    });

    it('skips a trashed draft', () => {
        expect(pickQuotableMessage([real('a'), trashedDraft('zz')])?.id).toBe('a');
    });

    it('skips a trashed non-draft message', () => {
        expect(pickQuotableMessage([real('a'), trashed('b')])?.id).toBe('a');
    });

    it('returns the last real message when several drafts trail it', () => {
        expect(
            pickQuotableMessage([real('a'), real('b'), draft('c'), draft('d')])?.id
        ).toBe('b');
    });

    it('returns the last message when nothing is a draft', () => {
        expect(pickQuotableMessage([real('a'), real('b')])?.id).toBe('b');
    });

    it('returns undefined when the thread holds only drafts', () => {
        expect(pickQuotableMessage([draft('a'), trashedDraft('b')])).toBeUndefined();
    });

    it('returns undefined for an empty thread', () => {
        expect(pickQuotableMessage([])).toBeUndefined();
    });

    it('treats a missing labelIds as quotable', () => {
        expect(pickQuotableMessage([{ id: 'a' } as any])?.id).toBe('a');
    });
});

describe('unwrapHtmlDocument', () => {
    it('removes the document wrappers so the quote nests validly', () => {
        const out = unwrapHtmlDocument(
            '<!DOCTYPE html><html><head><style>a{}</style></head><body><p>Hi</p></body></html>'
        );
        expect(out).toBe('<p>Hi</p>');
    });

    it('removes scripts', () => {
        expect(unwrapHtmlDocument('<div>a</div><script>evil()</script>')).toBe('<div>a</div>');
    });
});

describe('buildHtmlQuote', () => {
    const date = 'Thu, 3 Sep 2026 10:09:00 -0400';
    const from = 'Erika Pabo <erika.pabo@gmail.com>';

    it('produces a gmail_quote blockquote, not escaped text', () => {
        const q = buildHtmlQuote(from, date, '<div>Hello</div>', 'Hello');
        expect(q).toContain('class="gmail_quote gmail_quote_container"');
        expect(q).toContain('<blockquote class="gmail_quote"');
        expect(q).toContain('<div>Hello</div>');
    });

    it('renders the attribution line in Eastern time', () => {
        const q = buildHtmlQuote(from, date, '<div>Hello</div>', 'Hello');
        expect(q).toContain('Thu, Sep 3, 2026 at 10:09');
        expect(q).toContain('mailto:erika.pabo@gmail.com');
    });

    it('does not nest a full html document inside the blockquote', () => {
        const q = buildHtmlQuote(from, date, '<html><body><p>Hi</p></body></html>', 'Hi');
        expect(q).not.toContain('<html>');
        expect(q).not.toContain('<body>');
        expect(q).toContain('<p>Hi</p>');
    });

    it('falls back to the plain text when there is no HTML part', () => {
        const q = buildHtmlQuote(from, date, '', 'line one\nline two');
        expect(q).not.toContain('<html>');
        expect(q).toContain('line one');
        expect(q).toContain('line two');
    });
});

describe('buildPlainTextQuote', () => {
    it('prefixes every line with a single "> "', () => {
        const q = buildPlainTextQuote('A <a@b.com>', 'Thu, 3 Sep 2026 10:09:00 -0400', 'one\ntwo');
        expect(q).toContain('\n> one\n> two');
        expect(q).not.toContain('> > one');
    });
});

describe('index.ts auto-quote wiring', () => {
    // Source-level assertions: the mangling was a single wrong expression, and
    // a unit test cannot reach inside handleEmailAction without a Gmail client.
    const source = fs.readFileSync(
        fileURLToPath(new URL('./index.ts', import.meta.url)),
        'utf8'
    );

    it('no longer strips tags with a bare regex to build the text quote', () => {
        expect(source).not.toContain("quotedHtml.replace(/<[^>]+>/g, '')");
    });

    it('uses htmlToPlainText for the text quote fallback', () => {
        expect(source).toContain('quotedText || htmlToPlainText(quotedHtml)');
    });

    it('picks the quotable message rather than the raw last element', () => {
        expect(source).toContain('pickQuotableMessage(threadForQuote.data.messages');
    });

    it('builds the HTML quote from the body captured before the text quote', () => {
        expect(source).toContain('const replyBodyBeforeQuote = validatedArgs.body;');
        expect(source).toContain('buildPlainTextQuote(quotedFrom, quotedDate, textBody)');
    });

    it('filters drafts and trash out of the References chain', () => {
        expect(source).toMatch(/labels\.includes\('DRAFT'\) && !labels\.includes\('TRASH'\)/);
    });
});
