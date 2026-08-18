/**
 * Tests for inline (base64) attachment support:
 * - createEmailWithNodemailer accepts both file-path and inline-object attachment shapes
 * - SendEmailSchema/AttachmentInputSchema accept both shapes
 */

import { describe, it, expect } from 'vitest';
import { createEmailWithNodemailer } from './utl.js';
import { SendEmailSchema, AttachmentInputSchema } from './tools.js';

describe('createEmailWithNodemailer with inline attachments', () => {
    it('produces a raw RFC822 message containing the filename and a base64 body part for an inline attachment object', async () => {
        const args = {
            to: ['test@example.com'],
            subject: 'Inline attachment test',
            body: 'See attached.',
            attachments: [
                {
                    filename: 'note.txt',
                    mimeType: 'text/plain',
                    contentBase64: Buffer.from('hello inline world').toString('base64'),
                },
            ],
        };

        const raw = await createEmailWithNodemailer(args);

        expect(raw).toContain('note.txt');
        // nodemailer base64-encodes attachment content and wraps at 76 chars;
        // check for the un-wrapped base64 payload with wraps allowed.
        const expectedB64 = Buffer.from('hello inline world').toString('base64');
        const collapsed = raw.replace(/\r\n/g, '');
        expect(collapsed).toContain(expectedB64);
        expect(raw).toMatch(/Content-Transfer-Encoding: base64/i);
    });

    it('throws a clear error when a string attachment path does not exist', async () => {
        const args = {
            to: ['test@example.com'],
            subject: 'Missing file test',
            body: 'body',
            attachments: ['/definitely/does/not/exist/file.pdf'],
        };

        await expect(createEmailWithNodemailer(args)).rejects.toThrow(/does not exist/);
    });

    it('throws when total inline attachment bytes exceed the 20 MB cap', async () => {
        const oversized = Buffer.alloc(21 * 1024 * 1024, 'a').toString('base64');
        const args = {
            to: ['test@example.com'],
            subject: 'Oversized attachment test',
            body: 'body',
            attachments: [
                {
                    filename: 'big.bin',
                    contentBase64: oversized,
                },
            ],
        };

        await expect(createEmailWithNodemailer(args)).rejects.toThrow(/20 MB/);
    });
});

describe('Schema support for both attachment shapes', () => {
    it('AttachmentInputSchema accepts a file path string', () => {
        expect(() => AttachmentInputSchema.parse('/some/path/file.pdf')).not.toThrow();
    });

    it('AttachmentInputSchema accepts an inline object', () => {
        expect(() => AttachmentInputSchema.parse({
            filename: 'file.pdf',
            mimeType: 'application/pdf',
            contentBase64: 'aGVsbG8=',
        })).not.toThrow();
    });

    it('AttachmentInputSchema accepts an inline object without mimeType', () => {
        expect(() => AttachmentInputSchema.parse({
            filename: 'file.pdf',
            contentBase64: 'aGVsbG8=',
        })).not.toThrow();
    });

    it('SendEmailSchema accepts a mix of path and inline-object attachments', () => {
        const parsed = SendEmailSchema.parse({
            to: ['test@example.com'],
            subject: 'Subject',
            body: 'Body',
            attachments: [
                '/some/path/file.pdf',
                { filename: 'inline.txt', contentBase64: 'aGVsbG8=' },
            ],
        });
        expect(parsed.attachments).toHaveLength(2);
        expect(typeof parsed.attachments![0]).toBe('string');
        expect(typeof parsed.attachments![1]).toBe('object');
    });
});
