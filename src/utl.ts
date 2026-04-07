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
 * Build a plain-text quoted reply block.
 * Format: "On {date}, {from} wrote:\n> line1\n> line2..."
 */
export function buildPlainTextQuote(from: string, date: string, body: string): string {
    const quoted = body.split('\n').map(line => `> ${line}`).join('\n');
    return `\n\nOn ${date}, ${from} wrote:\n${quoted}`;
}

/**
 * Build an HTML quoted reply block with Gmail-style blockquote styling.
 */
export function buildHtmlQuote(from: string, date: string, bodyHtml: string, bodyText: string): string {
    // Use HTML body if available, otherwise convert plain text
    const content = bodyHtml || plainTextToHtml(bodyText).replace(/<\/?html>|<\/?body[^>]*>/g, '');
    return `<br><div class="gmail_quote"><div style="margin:0 0 8px 0;color:#888;">On ${date.replace(/</g, '&lt;').replace(/>/g, '&gt;')}, ${from.replace(/</g, '&lt;').replace(/>/g, '&gt;')} wrote:</div><blockquote style="margin:0 0 0 8px;padding:0 0 0 12px;border-left:2px solid #ccc;color:#555;">${content}</blockquote></div>`;
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
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
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

    // Common email headers
    const emailParts = [
        `From: ${from}`,
        `To: ${to}`,
        cc ? `Cc: ${cc}` : '',
        bcc ? `Bcc: ${bcc}` : '',
        `Subject: ${encodedSubject}`,
        inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
        references ? `References: ${references}` : '',
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

    // Prepare attachments for nodemailer
    const attachments = [];
    for (const filePath of validatedArgs.attachments) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File does not exist: ${filePath}`);
        }
        
        const fileName = path.basename(filePath);
        
        attachments.push({
            filename: fileName,
            path: filePath
        });
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
        references: validatedArgs.references || validatedArgs.inReplyTo
    };

    // Generate the raw message
    const info = await transporter.sendMail(mailOptions);
    const rawMessage = info.message.toString();
    
    return rawMessage;
}

