/**
 * Tests for inline attachment text extraction (attachment-extract.ts)
 */

import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { extractAttachmentText } from './attachment-extract.js';

// A minimal, hand-built valid PDF containing a single text object.
// This exercises the real pdf-parse/pdfjs-dist pipeline end-to-end.
const MINIMAL_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /MediaBox [0 0 300 144] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 55 >>
stream
BT /F1 24 Tf 20 100 Td (Hello PDF World) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`;

describe('extractAttachmentText', () => {
    it('extracts text from a CSV attachment', async () => {
        const buffer = Buffer.from('name,age\nJordan,40\n', 'utf8');
        const result = await extractAttachmentText(buffer, 'text/csv', 'people.csv');
        expect(result).not.toBeNull();
        expect(result!.kind).toBe('spreadsheet');
        expect(result!.text).toContain('Sheet1');
        expect(result!.text).toContain('Jordan');
        expect(result!.text).toContain('40');
    });

    it('extracts text from an XLSX attachment built with SheetJS', async () => {
        const workbook = XLSX.utils.book_new();
        const sheet = XLSX.utils.aoa_to_sheet([
            ['name', 'age'],
            ['Jordan', 40],
            ['Emma', 39],
        ]);
        XLSX.utils.book_append_sheet(workbook, sheet, 'Roster');
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

        const result = await extractAttachmentText(
            buffer,
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'roster.xlsx'
        );
        expect(result).not.toBeNull();
        expect(result!.kind).toBe('spreadsheet');
        expect(result!.text).toContain('## Sheet: Roster');
        expect(result!.text).toContain('name,age');
        expect(result!.text).toContain('Jordan,40');
        expect(result!.text).toContain('Emma,39');
    });

    it('extracts text from a minimal hand-built PDF', async () => {
        const buffer = Buffer.from(MINIMAL_PDF, 'latin1');
        const result = await extractAttachmentText(buffer, 'application/pdf', 'test.pdf');
        expect(result).not.toBeNull();
        expect(result!.kind).toBe('pdf');
        expect(result!.text).toContain('Hello PDF World');
    });

    it('extracts plain text attachments', async () => {
        const buffer = Buffer.from('just some plain text', 'utf8');
        const result = await extractAttachmentText(buffer, 'text/plain', 'notes.txt');
        expect(result).not.toBeNull();
        expect(result!.kind).toBe('text');
        expect(result!.text).toBe('just some plain text');
    });

    it('extracts and strips HTML attachments', async () => {
        const buffer = Buffer.from('<html><body><p>Hello <b>World</b></p></body></html>', 'utf8');
        const result = await extractAttachmentText(buffer, 'text/html', 'page.html');
        expect(result).not.toBeNull();
        expect(result!.kind).toBe('html');
        expect(result!.text).toContain('Hello');
        expect(result!.text).toContain('World');
        expect(result!.text).not.toContain('<b>');
    });

    it('returns null for an unsupported mime type', async () => {
        const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
        const result = await extractAttachmentText(buffer, 'application/octet-stream', 'photo.bin');
        expect(result).toBeNull();
    });

    it('returns null for unsupported types even with no recognizable extension', async () => {
        const buffer = Buffer.from('fake image bytes');
        const result = await extractAttachmentText(buffer, 'image/png', 'photo.png');
        expect(result).toBeNull();
    });

    it('truncates extracted text at 200,000 characters', async () => {
        const longText = 'a'.repeat(250_000);
        const buffer = Buffer.from(longText, 'utf8');
        const result = await extractAttachmentText(buffer, 'text/plain', 'huge.txt');
        expect(result).not.toBeNull();
        expect(result!.text.length).toBeLessThan(longText.length);
        expect(result!.text).toContain('[truncated: 50000 more characters]');
        expect(result!.text.startsWith('a'.repeat(200_000))).toBe(true);
    });

    it('does not truncate text under the limit', async () => {
        const shortText = 'a'.repeat(100);
        const buffer = Buffer.from(shortText, 'utf8');
        const result = await extractAttachmentText(buffer, 'text/plain', 'small.txt');
        expect(result!.text).toBe(shortText);
        expect(result!.text).not.toContain('truncated');
    });
});
