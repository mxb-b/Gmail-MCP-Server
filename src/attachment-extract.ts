import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { htmlToPlainText } from './utl.js';

const MAX_EXTRACTED_CHARS = 200_000;

function truncate(text: string): string {
    if (text.length <= MAX_EXTRACTED_CHARS) return text;
    const cut = text.slice(0, MAX_EXTRACTED_CHARS);
    const remaining = text.length - MAX_EXTRACTED_CHARS;
    return `${cut}\n\n[truncated: ${remaining} more characters]`;
}

function hasExtension(filename: string, exts: string[]): boolean {
    const lower = filename.toLowerCase();
    return exts.some(ext => lower.endsWith(ext));
}

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';
const CSV_MIME = 'text/csv';
const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'application/json']);
const HTML_MIMES = new Set(['text/html']);

function isPdf(mimeType: string, filename: string): boolean {
    return mimeType === PDF_MIME || hasExtension(filename, ['.pdf']);
}

function isDocx(mimeType: string, filename: string): boolean {
    return mimeType === DOCX_MIME || hasExtension(filename, ['.docx']);
}

function isSpreadsheet(mimeType: string, filename: string): boolean {
    return mimeType === XLSX_MIME || mimeType === XLS_MIME || mimeType === CSV_MIME
        || hasExtension(filename, ['.xlsx', '.xls', '.csv']);
}

function isPlainText(mimeType: string, filename: string): boolean {
    return TEXT_MIMES.has(mimeType) || hasExtension(filename, ['.txt', '.md', '.json']);
}

function isHtmlFile(mimeType: string, filename: string): boolean {
    return HTML_MIMES.has(mimeType) || hasExtension(filename, ['.htm', '.html']);
}

/**
 * Extract readable text from an attachment buffer, if the type is supported.
 * Returns null when the type is not extractable (caller should fall back to base64).
 */
export async function extractAttachmentText(
    buffer: Buffer,
    mimeType: string,
    filename: string
): Promise<{ text: string; kind: string } | null> {
    const mt = (mimeType || '').toLowerCase();
    const name = filename || '';

    if (isPdf(mt, name)) {
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        try {
            const result = await parser.getText();
            return { text: truncate(result.text), kind: 'pdf' };
        } finally {
            await parser.destroy();
        }
    }

    if (isDocx(mt, name)) {
        const result = await mammoth.extractRawText({ buffer });
        return { text: truncate(result.value), kind: 'docx' };
    }

    if (isSpreadsheet(mt, name)) {
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sections = workbook.SheetNames.map(sheetName => {
            const sheet = workbook.Sheets[sheetName];
            const csv = XLSX.utils.sheet_to_csv(sheet);
            return `## Sheet: ${sheetName}\n${csv}`;
        });
        return { text: truncate(sections.join('\n\n')), kind: 'spreadsheet' };
    }

    if (isHtmlFile(mt, name)) {
        const decoded = buffer.toString('utf8');
        return { text: truncate(htmlToPlainText(decoded)), kind: 'html' };
    }

    if (isPlainText(mt, name)) {
        const decoded = buffer.toString('utf8');
        return { text: truncate(decoded), kind: 'text' };
    }

    return null;
}
