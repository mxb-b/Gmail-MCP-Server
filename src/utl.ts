import fs from 'fs';
import path from 'path';
import { lookup as mimeLookup } from 'mime-types';
import nodemailer from 'nodemailer';

/**
 * Helper function to encode email headers containing non-ASCII characters
 * according to RFC 2047 MIME specification
 */
function encodeEmailHeader(text: string): string {
    // Only encode if the text contains non-ASCII characters
    if (/[^\x00-\x7F]/.test(text)) {
        // Use MIME Words encoding (RFC 2047)
        return '=?UTF-8?B?' + Buffer.from(text).toString('base64') + '?=';
    }
    return text;
}

/**
 * Format an RFC 2822 date string to Gmail's quote attribution format in Eastern time.
 * Input:  "Tue, 7 Apr 2026 13:37:52 -0400" (or similar RFC 2822)
 * Output: "Tue, Apr 7, 2026 at 1:37 PM"
 */
export function formatQuoteDate(dateStr: string): string {
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;

        // Format in America/New_York (Eastern time)
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
        }).formatToParts(d);

        const get = (type: string) => parts.find(p => p.type === type)?.value || '';
        // Gmail format: "On Tue, Apr 7, 2026 at 10:14 AM"
        return `${get('weekday')}, ${get('month')} ${get('day')}, ${get('year')} at ${get('hour')}:${get('minute')}\u202F${get('dayPeriod')}`;
    } catch {
        return dateStr;
    }
}

/**
 * Escape a string for safe use in HTML attributes/content.
 */
function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Extract just the email address from a "Name <email>" formatted string.
 */
function extractEmail(from: string): { name: string; email: string } {
    const match = from.match(/^(.+?)\s*<([^>]+)>$/);
    if (match) return { name: match[1].trim(), email: match[2].trim() };
    return { name: from, email: from };
}

/**
 * Build a plain-text quoted reply block matching Gmail's format.
 * Format: "On Tue, Apr 7, 2026 at 1:37 PM Name <email> wrote:\n> line1\n> line2..."
 */
export function buildPlainTextQuote(from: string, date: string, body: string): string {
    const formattedDate = formatQuoteDate(date);
    const quoted = body.split('\n').map(line => `> ${line}`).join('\n');
    return `\n\nOn ${formattedDate} ${from} wrote:\n${quoted}`;
}

/**
 * Strip the document wrappers off a message body so it can be nested inside
 * another document (a quote blockquote) without invalid <html>/<body> nesting.
 */
export function unwrapHtmlDocument(html: string): string {
    return html
        .replace(/<!DOCTYPE[^>]*>/gi, '')
        .replace(/<\?xml[^>]*\?>/gi, '')
        .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<\/?html[^>]*>/gi, '')
        .replace(/<\/?body[^>]*>/gi, '')
        .trim();
}

/**
 * Build an HTML quoted reply block matching Gmail's native format.
 * Uses Gmail's actual CSS classes and inline styles.
 */
export function buildHtmlQuote(from: string, date: string, bodyHtml: string, bodyText: string): string {
    const formattedDate = formatQuoteDate(date);
    const { name, email } = extractEmail(from);
    // A quoted message is nested inside our document, so its own <html>/<head>/
    // <body> wrappers and any <script> must come off first. Leaving them in
    // produces invalid nesting that renderers recover from unpredictably.
    const content = bodyHtml
        ? unwrapHtmlDocument(bodyHtml)
        : unwrapHtmlDocument(plainTextToHtml(bodyText));

    const attrLine = `On ${escapeHtml(formattedDate)} ${escapeHtml(name)} &lt;<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>&gt; wrote:`;

    return `<br><div class="gmail_quote gmail_quote_container">` +
        `<div dir="ltr" class="gmail_attr">${attrLine}<br></div>` +
        `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">` +
        `${content}` +
        `</blockquote></div>`;
}

/**
 * Pick the message in a thread that a reply should quote and thread against.
 *
 * gmail.users.threads.get returns unsent DRAFT messages and TRASHed messages
 * alongside real ones, and they sort by Date like anything else. Taking the raw
 * last element therefore lets a draft sitting on the thread become the quoted
 * "previous message" and the In-Reply-To target. Observed 2026-09-04: a
 * self-addressed draft ("ZZ trash-test draft A (delete me)") was quoted into a
 * reply sent to a parent. replaceThreadDrafts makes drafts-on-threads common,
 * so this has to filter rather than hope.
 *
 * Returns the last message that is neither a DRAFT nor in the TRASH, or
 * undefined when the thread holds nothing quotable.
 */
export function pickQuotableMessage<T extends { labelIds?: string[] | null }>(
    threadMessages: T[]
): T | undefined {
    for (let i = threadMessages.length - 1; i >= 0; i--) {
        const labels = threadMessages[i].labelIds || [];
        if (labels.includes('DRAFT') || labels.includes('TRASH')) continue;
        return threadMessages[i];
    }
    return undefined;
}

export const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

/**
 * Sanitize a value destined for an email header to prevent CRLF injection.
 * Strips \r, \n, and \0 characters that could inject additional headers.
 */
function sanitizeHeaderValue(value: string): string {
    return value.replace(/[\r\n\0]/g, '');
}

/**
 * Detect if a string contains HTML markup.
 */
export function isHtml(text: string): boolean {
    return /<\/?(?:html|body|div|p|br|h[1-6]|ul|ol|li|table|tr|td|a|img|strong|em|b|i|span|blockquote)\b/i.test(text);
}

/**
 * Strip HTML tags to produce a plain text version.
 */
export function htmlToPlainText(html: string): string {
    return html
        // Drop non-rendered content outright, or its CSS/JS text survives the
        // tag strip and lands in the quote.
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
        // Block-level boundaries become line breaks.
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<\/(?:td|th)>/gi, '\t')
        .replace(/<\/li>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<\/blockquote>/gi, '\n')
        // Opening block tags start a new line too. Apple Mail and iOS Mail write
        // runs of bare <div>s with no <br>, so without this the text collapses
        // into "Thank you!!Erika".
        .replace(/<(?:div|p|tr|h[1-6]|table|ul|ol|blockquote|section|article)\b[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        // Entities. Numeric first, then named, and &amp; LAST: decoding it first
        // turns "&amp;lt;" into "<" instead of the literal "&lt;" the sender wrote.
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&amp;/gi, '&')
        // Tidy the whitespace the tag strip leaves behind.
        .replace(/[\u00a0\u202f]/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Convert plain text email body to simple HTML.
 * Double newlines become paragraph breaks, single newlines become <br>.
 * HTML entities are escaped.
 */
export function plainTextToHtml(text: string): string {
    // Escape HTML entities
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    // Split into paragraphs on double newlines, then convert single newlines to <br>
    const paragraphs = escaped.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    const htmlBody = paragraphs.map(p => `<p style="margin:0 0 16px 0;">${p.replace(/\n/g, '<br>')}</p>`).join('\n');

    return `<html><body style="font-family:sans-serif;font-size:14px;color:#222;">${htmlBody}</body></html>`;
}

export function createEmailMessage(validatedArgs: any): string {
    const encodedSubject = encodeEmailHeader(sanitizeHeaderValue(validatedArgs.subject));
    // Determine content type based on available content and explicit mimeType
    let mimeType = validatedArgs.mimeType || 'text/plain';

    // If htmlBody is provided and mimeType isn't explicitly set to text/plain,
    // use multipart/alternative to include both versions
    if (validatedArgs.htmlBody && mimeType !== 'text/plain') {
        mimeType = 'multipart/alternative';
    }

    // Auto-upgrade: when sending with no explicit htmlBody,
    // detect whether body is HTML or plain text and handle accordingly
    if (!validatedArgs.htmlBody) {
        if (isHtml(validatedArgs.body)) {
            // Body contains HTML markup — use it as htmlBody, generate plain text fallback
            validatedArgs.htmlBody = validatedArgs.body;
            validatedArgs.body = htmlToPlainText(validatedArgs.body);
        } else {
            // Plain text — generate an HTML version to prevent Gmail line-break issues
            validatedArgs.htmlBody = plainTextToHtml(validatedArgs.body);
        }
        mimeType = 'multipart/alternative';
    }

    // Generate a random boundary string for multipart messages
    const boundary = `----=_NextPart_${Math.random().toString(36).substring(2)}`;

    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Sanitize all user-supplied header values to prevent CRLF injection
    const from = sanitizeHeaderValue(validatedArgs.from || 'me');
    const to = (validatedArgs.to as string[]).map(sanitizeHeaderValue).join(', ');
    const cc = validatedArgs.cc ? (validatedArgs.cc as string[]).map(sanitizeHeaderValue).join(', ') : '';
    const bcc = validatedArgs.bcc ? (validatedArgs.bcc as string[]).map(sanitizeHeaderValue).join(', ') : '';
    const inReplyTo = validatedArgs.inReplyTo ? sanitizeHeaderValue(validatedArgs.inReplyTo) : '';
    const references = validatedArgs.references
        ? sanitizeHeaderValue(validatedArgs.references)
        : validatedArgs.inReplyTo ? sanitizeHeaderValue(validatedArgs.inReplyTo) : '';

    // Extra headers (e.g. X-Scheduled-Send-At) that callers want carried on the raw
    // message. Sanitized the same way as the standard headers to prevent CRLF injection.
    const extraHeaderLines: string[] = validatedArgs.extraHeaders
        ? Object.entries(validatedArgs.extraHeaders as Record<string, string>)
            .map(([key, value]) => `${sanitizeHeaderValue(key)}: ${sanitizeHeaderValue(String(value))}`)
        : [];

    // Common email headers
    const emailParts = [
        `From: ${from}`,
        `To: ${to}`,
        cc ? `Cc: ${cc}` : '',
        bcc ? `Bcc: ${bcc}` : '',
        `Subject: ${encodedSubject}`,
        inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
        references ? `References: ${references}` : '',
        ...extraHeaderLines,
        'MIME-Version: 1.0',
    ].filter(Boolean);

    // Construct the email based on the content type
    if (mimeType === 'multipart/alternative') {
        // Multipart email with both plain text and HTML
        emailParts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        emailParts.push('');
        
        // Plain text part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
        emailParts.push('');
        
        // HTML part
        emailParts.push(`--${boundary}`);
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body); // Use body as fallback
        emailParts.push('');
        
        // Close the boundary
        emailParts.push(`--${boundary}--`);
    } else if (mimeType === 'text/html') {
        // HTML-only email
        emailParts.push('Content-Type: text/html; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.htmlBody || validatedArgs.body);
    } else {
        // Plain text email (default)
        emailParts.push('Content-Type: text/plain; charset=UTF-8');
        emailParts.push('Content-Transfer-Encoding: 7bit');
        emailParts.push('');
        emailParts.push(validatedArgs.body);
    }

    return emailParts.join('\r\n');
}


// 20 MB cap on total decoded inline attachment bytes per email.
const MAX_INLINE_ATTACHMENTS_BYTES = 20 * 1024 * 1024;

/** An attachment is either a server file path (legacy) or inline bytes carried as base64. */
export type AttachmentInput = string | { filename: string; mimeType?: string; contentBase64: string };

export async function createEmailWithNodemailer(validatedArgs: any): Promise<string> {
    // Validate email addresses
    (validatedArgs.to as string[]).forEach(email => {
        if (!validateEmail(email)) {
            throw new Error(`Recipient email address is invalid: ${email}`);
        }
    });

    // Create a nodemailer transporter (we won't actually send, just generate the message)
    const transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
        buffer: true
    });

    // Prepare attachments for nodemailer. Each item is either a server file path (legacy)
    // or an inline object carrying base64-encoded bytes directly from the caller.
    const attachments: Array<{ filename: string; path?: string; content?: Buffer; contentType?: string }> = [];
    let totalInlineBytes = 0;
    for (const item of (validatedArgs.attachments as AttachmentInput[])) {
        if (typeof item === 'string') {
            const filePath = item;
            if (!fs.existsSync(filePath)) {
                throw new Error(`File does not exist: ${filePath}`);
            }

            const fileName = path.basename(filePath);

            attachments.push({
                filename: fileName,
                path: filePath
            });
        } else {
            const content = Buffer.from(item.contentBase64, 'base64');
            totalInlineBytes += content.length;
            if (totalInlineBytes > MAX_INLINE_ATTACHMENTS_BYTES) {
                throw new Error(`Inline attachments exceed the ${MAX_INLINE_ATTACHMENTS_BYTES / (1024 * 1024)} MB total limit`);
            }

            const attachment: { filename: string; content: Buffer; contentType?: string } = {
                filename: item.filename,
                content,
            };
            if (item.mimeType) attachment.contentType = item.mimeType;
            attachments.push(attachment);
        }
    }

    // Auto-generate HTML for attachment emails too, with HTML detection
    let htmlBody = validatedArgs.htmlBody;
    if (!htmlBody) {
        if (isHtml(validatedArgs.body)) {
            htmlBody = validatedArgs.body;
            validatedArgs.body = htmlToPlainText(validatedArgs.body);
        } else {
            htmlBody = plainTextToHtml(validatedArgs.body);
        }
    }

    const mailOptions = {
        from: validatedArgs.from || 'me', // Gmail API uses default send-as if 'me', or specified alias
        to: validatedArgs.to.join(', '),
        cc: validatedArgs.cc?.join(', '),
        bcc: validatedArgs.bcc?.join(', '),
        subject: validatedArgs.subject,
        text: validatedArgs.body,
        html: htmlBody,
        attachments: attachments,
        inReplyTo: validatedArgs.inReplyTo,
        references: validatedArgs.references || validatedArgs.inReplyTo,
        headers: validatedArgs.extraHeaders as Record<string, string> | undefined,
    };

    // Generate the raw message
    const info = await transporter.sendMail(mailOptions);
    const rawMessage = info.message.toString();
    
    return rawMessage;
}

