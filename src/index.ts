#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import open from 'open';
import os from 'os';
import {createEmailMessage, createEmailWithNodemailer, buildPlainTextQuote, buildHtmlQuote} from "./utl.js";
import { extractAttachmentText } from "./attachment-extract.js";
import { extension as mimeExtension } from "mime-types";
import { createLabel, updateLabel, deleteLabel, listLabels, findLabelByName, getOrCreateLabel, GmailLabel } from "./label-manager.js";
import { createFilter, listFilters, getFilter, deleteFilter, filterTemplates, GmailFilterCriteria, GmailFilterAction } from "./filter-manager.js";
import { parseEmailAddresses, filterOutEmail, addRePrefix, buildReferencesHeader, buildReplyAllRecipients } from "./reply-all-helpers.js";
import { DEFAULT_SCOPES, scopeNamesToUrls, parseScopes, validateScopes, hasScope, getAvailableScopeNames } from "./scopes.js";
import { toolDefinitions, toMcpTools, getToolByName, SearchContactsSchema, GetContactPhotoSchema, SendEmailSchema, DraftEmailSchema, ReadEmailSchema, SearchEmailsSchema, ModifyEmailSchema, DeleteEmailSchema, DeleteDraftSchema, BatchModifyEmailsSchema, BatchDeleteEmailsSchema, CreateLabelSchema, UpdateLabelSchema, DeleteLabelSchema, GetOrCreateLabelSchema, CreateFilterSchema, GetFilterSchema, DeleteFilterSchema, CreateFilterFromTemplateSchema, DownloadAttachmentSchema, ReplyAllSchema, GetThreadSchema, ListInboxThreadsSchema, GetInboxWithThreadsSchema, DownloadEmailSchema, ScheduleEmailSchema, ListScheduledEmailsSchema, CancelScheduledEmailSchema, SendDueScheduledEmailsSchema } from "./tools.js";
import { gmailMessageToJson, emailToTxt, emailToHtml, EmailAttachment } from "./email-export.js";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./timeout.js";
import { fetchScheduledDrafts, markDraftScheduled, cancelScheduledEmail, sendDueScheduledEmails, SCHEDULED_SEND_HEADER } from "./scheduled-send.js";
import { searchContacts, getContactPhoto } from "./people.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration paths
const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, 'credentials.json');

// Type definitions for Gmail API responses
interface GmailMessagePart {
    partId?: string;
    mimeType?: string;
    filename?: string;
    headers?: Array<{
        name: string;
        value: string;
    }>;
    body?: {
        attachmentId?: string;
        size?: number;
        data?: string;
    };
    parts?: GmailMessagePart[];
}

interface EmailContent {
    text: string;
    html: string;
}

// OAuth2 configuration
let oauth2Client: OAuth2Client;
let authorizedScopes: string[] = DEFAULT_SCOPES;

/**
 * Recursively extract email body content from MIME message parts
 * Handles complex email structures with nested parts
 */
function extractEmailContent(messagePart: GmailMessagePart): EmailContent {
    // Initialize containers for different content types
    let textContent = '';
    let htmlContent = '';

    // If the part has a body with data, process it based on MIME type
    if (messagePart.body && messagePart.body.data) {
        const content = Buffer.from(messagePart.body.data, 'base64').toString('utf8');

        // Store content based on its MIME type
        if (messagePart.mimeType === 'text/plain') {
            textContent = content;
        } else if (messagePart.mimeType === 'text/html') {
            htmlContent = content;
        }
    }

    // If the part has nested parts, recursively process them
    if (messagePart.parts && messagePart.parts.length > 0) {
        for (const part of messagePart.parts) {
            const { text, html } = extractEmailContent(part);
            if (text) textContent += text;
            if (html) htmlContent += html;
        }
    }

    // Return both plain text and HTML content
    return { text: textContent, html: htmlContent };
}

/**
 * Extract common headers from Gmail message payload
 */
function extractHeaders(payload: any): { subject: string; from: string; to: string; date: string; rfcMessageId: string } {
    const headers = payload?.headers || [];
    const getHeader = (name: string) =>
        headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
    return {
        subject: getHeader("subject"),
        from: getHeader("from"),
        to: getHeader("to"),
        date: getHeader("date"),
        rfcMessageId: getHeader("message-id"),
    };
}

/**
 * Extract attachments from Gmail message payload
 */
function extractAttachments(payload: GmailMessagePart): EmailAttachment[] {
    const attachments: EmailAttachment[] = [];

    function processAttachmentParts(part: GmailMessagePart) {
        if (part.body && part.body.attachmentId) {
            attachments.push({
                id: part.body.attachmentId,
                filename: part.filename || `attachment-${part.body.attachmentId}`,
                mimeType: part.mimeType || "application/octet-stream",
                size: part.body.size || 0,
            });
        }
        if (part.parts) {
            part.parts.forEach((subpart: GmailMessagePart) => processAttachmentParts(subpart));
        }
    }

    processAttachmentParts(payload);
    return attachments;
}

async function loadCredentials() {
    try {
        // Create config directory if it doesn't exist
        if (!process.env.GMAIL_OAUTH_PATH && !process.env.GMAIL_CREDENTIALS_PATH && !fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
        }

        // Check for OAuth keys in current directory first, then in config directory
        const localOAuthPath = path.join(process.cwd(), 'gcp-oauth.keys.json');
        let oauthPath = OAUTH_PATH;

        if (fs.existsSync(localOAuthPath)) {
            // If found in current directory, copy to config directory
            fs.copyFileSync(localOAuthPath, OAUTH_PATH);
            console.log('OAuth keys found in current directory, copied to global config.');
        }

        if (!fs.existsSync(OAUTH_PATH)) {
            console.error('Error: OAuth keys file not found. Please place gcp-oauth.keys.json in current directory or', CONFIG_DIR);
            process.exit(1);
        }

        const keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'));
        const keys = keysContent.installed || keysContent.web;

        if (!keys) {
            console.error('Error: Invalid OAuth keys file format. File should contain either "installed" or "web" credentials.');
            process.exit(1);
        }

        // Parse callback URL from args (must be a URL, not a flag)
        // Supports: node index.js auth https://example.com/callback
        // Or: node index.js auth --scopes=gmail.readonly (uses default callback)
        const callbackArg = process.argv.find(arg =>
            arg.startsWith('http://') || arg.startsWith('https://')
        );
        const callback = callbackArg || "http://localhost:3000/oauth2callback";

        oauth2Client = new OAuth2Client(
            keys.client_id,
            keys.client_secret,
            callback
        );

        if (fs.existsSync(CREDENTIALS_PATH)) {
            const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));

            // Credentials file structure (v1.2.0+):
            //   { "tokens": { access_token, refresh_token, ... }, "scopes": ["gmail.readonly", ...] }
            //
            // Legacy structure (pre-v1.2.0):
            //   { access_token, refresh_token, ... }
            //
            // We support both formats for backwards compatibility. Users with legacy
            // credentials will get DEFAULT_SCOPES (full access) until they re-authenticate.
            const tokens = credentials.tokens || credentials;
            oauth2Client.setCredentials(tokens);

            if (credentials.scopes) {
                authorizedScopes = credentials.scopes;
            }
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
        process.exit(1);
    }
}

async function authenticate(scopes: string[]) {
    const server = http.createServer();
    server.listen(3000, '127.0.0.1');

    // Convert shorthand scope names (e.g., "gmail.readonly") to full Google API URLs
    const scopeUrls = scopeNamesToUrls(scopes);

    return new Promise<void>((resolve, reject) => {
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopeUrls,
        });

        console.log('Requesting scopes:', scopes.join(', '));
        console.log('Please visit this URL to authenticate:', authUrl);
        open(authUrl);

        server.on('request', async (req, res) => {
            if (!req.url?.startsWith('/oauth2callback')) return;

            const url = new URL(req.url, 'http://localhost:3000');
            const code = url.searchParams.get('code');

            if (!code) {
                res.writeHead(400);
                res.end('No code provided');
                reject(new Error('No code provided'));
                return;
            }

            try {
                const { tokens } = await oauth2Client.getToken(code);
                oauth2Client.setCredentials(tokens);

                // Store both tokens and authorized scopes for runtime filtering
                const credentials = { tokens, scopes };
                fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), { mode: 0o600 });

                res.writeHead(200);
                res.end('Authentication successful! You can close this window.');
                console.log('Credentials saved with scopes:', scopes.join(', '));
                server.close();
                resolve();
            } catch (error) {
                res.writeHead(500);
                res.end('Authentication failed');
                reject(error);
            }
        });
    });
}

// Main function
/**
 * Security-relevant headers for phishing and mailing-list detection. Returned as extra
 * "Header: value" lines under the standard From/To/Date block of read_email.
 */
function formatSecurityHeaders(headers: Array<{ name?: string | null; value?: string | null }>): string {
    const wanted = ['reply-to', 'return-path', 'sender', 'list-unsubscribe', 'list-id', 'precedence', 'x-phishtest', 'x-phish-test'];
    const lines: string[] = [];
    for (const h of headers) {
        const name = (h.name || '').toLowerCase();
        const value = (h.value || '').trim();
        if (!value) continue;
        if (name === 'authentication-results') {
            // Condense to the spf/dkim/dmarc verdicts, which is what a reader needs.
            const verdicts = Array.from(value.matchAll(/\b(spf|dkim|dmarc)=([a-z]+)/gi)).map(m => `${m[1].toLowerCase()}=${m[2].toLowerCase()}`);
            const seen = new Set<string>();
            const uniq = verdicts.filter(v => (seen.has(v) ? false : (seen.add(v), true)));
            if (uniq.length) lines.push(`Authentication-Results: ${uniq.join(' ')}`);
            continue;
        }
        if (wanted.includes(name) || name.startsWith('x-phish') || name.startsWith('x-knowbe4') || name.startsWith('x-kb4')) {
            lines.push(`${h.name}: ${value.length > 300 ? value.slice(0, 300) + '…' : value}`);
        }
    }
    return lines.length ? '\n' + lines.join('\n') : '';
}

/**
 * List the actual link targets in a message so the reader can compare display text with
 * the real destination. HTML anchors first (with their visible text), then bare URLs from
 * the plain-text part. Capped at 40 unique links.
 */
function formatLinks(text: string, html: string): string {
    const links: Array<{ href: string; label: string }> = [];
    const seen = new Set<string>();
    const add = (href: string, label: string) => {
        const clean = href.trim();
        if (!/^https?:\/\//i.test(clean) || seen.has(clean) || links.length >= 40) return;
        seen.add(clean);
        links.push({ href: clean, label: label.trim() });
    };
    if (html) {
        for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
            const label = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
            add(m[1], label);
        }
    }
    if (text) {
        for (const m of text.matchAll(/https?:\/\/[^\s<>"'\)\]]+/g)) add(m[0].replace(/[.,;:]+$/, ''), '');
    }
    if (!links.length) return '';
    const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
    const lines = links.map(l => {
        const host = hostOf(l.href);
        let flag = '';
        const labelHostMatch = l.label.match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})(?:[\/\s]|$)/i);
        if (labelHostMatch && host && !host.endsWith(labelHostMatch[1].toLowerCase()) && !labelHostMatch[1].toLowerCase().endsWith(host)) {
            flag = '  [display/target host mismatch]';
        }
        return l.label ? `- "${l.label.slice(0, 80)}" -> ${l.href}${flag}` : `- ${l.href}`;
    });
    return `\n\nLinks (${links.length}):\n${lines.join('\n')}`;
}

async function main() {
    await loadCredentials();

    if (process.argv[2] === 'auth') {
        // Parse --scopes flag from CLI arguments
        // Usage: node dist/index.js auth --scopes=<scope1,scope2,...>
        // Example: node dist/index.js auth --scopes=gmail.readonly
        // Example: node dist/index.js auth --scopes=gmail.readonly,gmail.settings.basic
        const scopesArg = process.argv.find(arg => arg.startsWith('--scopes='));
        let scopes = DEFAULT_SCOPES;

        if (scopesArg) {
            const scopesValue = scopesArg.slice('--scopes='.length);
            scopes = parseScopes(scopesValue);
            const validation = validateScopes(scopes);

            if (!validation.valid) {
                console.error('Error: Invalid scope(s):', validation.invalid.join(', '));
                console.error('Available scopes:', getAvailableScopeNames().join(', '));
                process.exit(1);
            }
        } else {
            console.log('No --scopes flag specified, using defaults:', DEFAULT_SCOPES.join(', '));
            console.log('Tip: Use --scopes=gmail.readonly for read-only access');
            console.log('Available scopes:', getAvailableScopeNames().join(', '));
        }

        await authenticate(scopes);
        console.log('Authentication completed successfully');
        process.exit(0);
    }

    // Initialize Gmail API
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Server implementation
    const server = new Server(
        {
            name: "gmail",
            version: "1.0.0",
        },
        {
            capabilities: {
                tools: {},
            },
        },
    );

    // Tool handlers
    // Filter available tools based on authorized scopes
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const availableTools = toolDefinitions.filter(tool =>
            hasScope(authorizedScopes, tool.scopes)
        );
        return { tools: toMcpTools(availableTools) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        // Verify the tool is authorized for the current scopes
        // This guards against direct tool calls that bypass ListTools
        const toolDef = getToolByName(name);
        if (!toolDef || !hasScope(authorizedScopes, toolDef.scopes)) {
            return {
                content: [{
                    type: "text",
                    text: `Error: Tool "${name}" is not available. You may need to re-authenticate with additional scopes.`,
                }],
            };
        }

        async function handleEmailAction(action: "send" | "draft" | "schedule", validatedArgs: any) {
            let message: string;

            try {
                // Auto-resolve threading headers when threadId is provided but inReplyTo is missing
                if (validatedArgs.threadId && !validatedArgs.inReplyTo) {
                    try {
                        const threadResponse = await withTimeout(gmail.users.threads.get({
                            userId: 'me',
                            id: validatedArgs.threadId,
                            format: 'metadata',
                            metadataHeaders: ['Message-ID'],
                        }), DEFAULT_TIMEOUT_MS, 'threads.get for header resolution');

                        const threadMessages = threadResponse.data.messages || [];
                        if (threadMessages.length > 0) {
                            // Collect all Message-ID values for the References chain
                            const allMessageIds: string[] = [];
                            for (const msg of threadMessages) {
                                const msgHeaders = msg.payload?.headers || [];
                                const messageIdHeader = msgHeaders.find(
                                    (h) => h.name?.toLowerCase() === 'message-id'
                                );
                                if (messageIdHeader?.value) {
                                    allMessageIds.push(messageIdHeader.value);
                                }
                            }

                            // Last message's Message-ID becomes In-Reply-To
                            const lastMessage = threadMessages[threadMessages.length - 1];
                            const lastHeaders = lastMessage.payload?.headers || [];
                            const lastMessageId = lastHeaders.find(
                                (h) => h.name?.toLowerCase() === 'message-id'
                            )?.value;

                            if (lastMessageId) {
                                validatedArgs.inReplyTo = lastMessageId;
                            }
                            if (allMessageIds.length > 0) {
                                validatedArgs.references = allMessageIds.join(' ');
                            }
                        }
                    } catch (threadError: any) {
                        console.warn(`Warning: Could not fetch thread ${validatedArgs.threadId} for header resolution: ${threadError.message}`);
                        // Continue without threading headers - degraded but not broken
                    }
                }

                // Auto-quote: when replying to a thread, fetch the last message and append quoted text
                if (validatedArgs.threadId && validatedArgs.inReplyTo && !validatedArgs._skipQuote) {
                    try {
                        const threadForQuote = await withTimeout(gmail.users.threads.get({
                            userId: 'me',
                            id: validatedArgs.threadId,
                            format: 'full',
                        }), DEFAULT_TIMEOUT_MS, 'threads.get for quote');

                        const threadMessages = threadForQuote.data.messages || [];
                        if (threadMessages.length > 0) {
                            const lastMsg = threadMessages[threadMessages.length - 1];
                            const lastHeaders = lastMsg.payload?.headers || [];
                            const quotedFrom = lastHeaders.find(h => h.name?.toLowerCase() === 'from')?.value || '';
                            const quotedDate = lastHeaders.find(h => h.name?.toLowerCase() === 'date')?.value || '';

                            const { text: quotedText, html: quotedHtml } = extractEmailContent(lastMsg.payload as GmailMessagePart || {});

                            if (quotedText || quotedHtml) {
                                // Append plain text quote
                                const textBody = quotedText || quotedHtml.replace(/<[^>]+>/g, '');
                                validatedArgs.body = validatedArgs.body + buildPlainTextQuote(quotedFrom, quotedDate, textBody);

                                // Append HTML quote
                                if (validatedArgs.htmlBody) {
                                    // Insert before closing </body></html> if present
                                    validatedArgs.htmlBody = validatedArgs.htmlBody.replace(
                                        /<\/body>\s*<\/html>\s*$/i,
                                        buildHtmlQuote(quotedFrom, quotedDate, quotedHtml, quotedText) + '</body></html>'
                                    );
                                    // If no closing tags matched, just append
                                    if (!validatedArgs.htmlBody.includes('gmail_quote')) {
                                        validatedArgs.htmlBody = validatedArgs.htmlBody + buildHtmlQuote(quotedFrom, quotedDate, quotedHtml, quotedText);
                                    }
                                }
                            }
                        }
                    } catch (quoteError: any) {
                        console.warn(`Warning: Could not fetch thread for quoting: ${quoteError.message}`);
                        // Continue without quote - degraded but not broken
                    }
                }

                // Check if we have attachments
                if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
                    // Use Nodemailer to create properly formatted RFC822 message
                    message = await createEmailWithNodemailer(validatedArgs);
                    
                    if (action === "send") {
                        const encodedMessage = Buffer.from(message).toString('base64')
                            .replace(/\+/g, '-')
                            .replace(/\//g, '_')
                            .replace(/=+$/, '');

                        const result = await withTimeout(gmail.users.messages.send({
                            userId: 'me',
                            requestBody: {
                                raw: encodedMessage,
                                ...(validatedArgs.threadId && { threadId: validatedArgs.threadId })
                            }
                        }), DEFAULT_TIMEOUT_MS, 'messages.send with attachments');
                        
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Email sent successfully with ID: ${result.data.id}`,
                                },
                            ],
                        };
                    } else {
                        // For drafts (and scheduled sends) with attachments, use the raw message
                        const encodedMessage = Buffer.from(message).toString('base64')
                            .replace(/\+/g, '-')
                            .replace(/\//g, '_')
                            .replace(/=+$/, '');

                        const messageRequest = {
                            raw: encodedMessage,
                            ...(validatedArgs.threadId && { threadId: validatedArgs.threadId })
                        };

                        const response = await withTimeout(gmail.users.drafts.create({
                            userId: 'me',
                            requestBody: {
                                message: messageRequest,
                            },
                        }), DEFAULT_TIMEOUT_MS, 'drafts.create with attachments');

                        if (action === "schedule") {
                            await markDraftScheduled(gmail, response.data.message!.id!);
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Email scheduled successfully. Draft ID: ${response.data.id}. Will send at ${validatedArgs.sendAt} (visible and editable in Gmail under the "Scheduled" label until then).`,
                                    },
                                ],
                            };
                        }
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Email draft created successfully with ID: ${response.data.id}`,
                                },
                            ],
                        };
                    }
                } else {
                    // For emails without attachments, use the existing simple method
                    message = createEmailMessage(validatedArgs);
                    
                    const encodedMessage = Buffer.from(message).toString('base64')
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=+$/, '');

                    // Define the type for messageRequest
                    interface GmailMessageRequest {
                        raw: string;
                        threadId?: string;
                    }

                    const messageRequest: GmailMessageRequest = {
                        raw: encodedMessage,
                    };

                    // Add threadId if specified
                    if (validatedArgs.threadId) {
                        messageRequest.threadId = validatedArgs.threadId;
                    }

                    if (action === "send") {
                        const response = await withTimeout(gmail.users.messages.send({
                            userId: 'me',
                            requestBody: messageRequest,
                        }), DEFAULT_TIMEOUT_MS, 'messages.send');
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Email sent successfully with ID: ${response.data.id}`,
                                },
                            ],
                        };
                    } else {
                        const response = await withTimeout(gmail.users.drafts.create({
                            userId: 'me',
                            requestBody: {
                                message: messageRequest,
                        },
                        }), DEFAULT_TIMEOUT_MS, 'drafts.create');

                        if (action === "schedule") {
                            await markDraftScheduled(gmail, response.data.message!.id!);
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Email scheduled successfully. Draft ID: ${response.data.id}. Will send at ${validatedArgs.sendAt} (visible and editable in Gmail under the "Scheduled" label until then).`,
                                    },
                                ],
                            };
                        }
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Email draft created successfully with ID: ${response.data.id}`,
                                },
                            ],
                        };
                    }
                }
            } catch (error: any) {
                // Log attachment-related errors for debugging
                if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
                    console.error(`Failed to send email with ${validatedArgs.attachments.length} attachments:`, error.message);
                }
                throw error;
            }
        }

        // Deletes every existing draft on the given thread, for draft_email's replaceThreadDrafts option.
        // The Gmail API has no server-side "drafts on this thread" filter (drafts.list's q param uses
        // normal Gmail search syntax, which doesn't support filtering by threadId), so this lists all of
        // the account's drafts, paginating via nextPageToken, and filters client-side on
        // draft.message.threadId -- the drafts.list response includes message.id and message.threadId for
        // each draft by default (see Schema$ListDraftsResponse), so no extra drafts.get calls are needed.
        // Note: this deletes ALL matching drafts, including ones not created by this tool (e.g. a human's
        // own in-progress draft on the same thread) -- that's why the caller only reaches here when
        // replaceThreadDrafts was explicitly requested.
        async function deleteThreadDrafts(threadId: string): Promise<{ draftId: string; messageId: string }[]> {
            const matches: { draftId: string; messageId: string }[] = [];
            let pageToken: string | undefined = undefined;
            do {
                const page: any = await withTimeout(gmail.users.drafts.list({
                    userId: 'me',
                    maxResults: 100,
                    pageToken,
                }), DEFAULT_TIMEOUT_MS, 'drafts.list for replaceThreadDrafts');
                for (const d of (page.data.drafts || [])) {
                    if (d.message?.threadId === threadId && d.id && d.message?.id) {
                        matches.push({ draftId: d.id, messageId: d.message.id });
                    }
                }
                pageToken = page.data.nextPageToken || undefined;
            } while (pageToken);

            for (const match of matches) {
                await withTimeout(gmail.users.drafts.delete({
                    userId: 'me',
                    id: match.draftId,
                }), DEFAULT_TIMEOUT_MS, 'drafts.delete for replaceThreadDrafts');
            }

            return matches;
        }

        // Helper function to process operations in batches
        async function processBatches<T, U>(
            items: T[],
            batchSize: number,
            processFn: (batch: T[]) => Promise<U[]>
        ): Promise<{ successes: U[], failures: { item: T, error: Error }[] }> {
            const successes: U[] = [];
            const failures: { item: T, error: Error }[] = [];
            
            // Process in batches
            for (let i = 0; i < items.length; i += batchSize) {
                const batch = items.slice(i, i + batchSize);
                try {
                    const results = await processFn(batch);
                    successes.push(...results);
                } catch (error) {
                    // If batch fails, try individual items
                    for (const item of batch) {
                        try {
                            const result = await processFn([item]);
                            successes.push(...result);
                        } catch (itemError) {
                            failures.push({ item, error: itemError as Error });
                        }
                    }
                }
            }
            
            return { successes, failures };
        }

        try {
            switch (name) {
                case "send_email":
                case "draft_email": {
                    const isDraft = name === "draft_email";
                    const validatedArgs = isDraft ? DraftEmailSchema.parse(args) : SendEmailSchema.parse(args);
                    if (validatedArgs.skipQuote) {
                        (validatedArgs as any)._skipQuote = true;
                    }
                    const action = isDraft ? "draft" : "send";

                    // Opt-in one-draft-per-thread: replace any existing drafts on this thread before
                    // creating the new one. No-op (explicitly skipped, not just naturally empty) when
                    // there's no threadId to scope the replacement to.
                    let replacedDrafts: { draftId: string; messageId: string }[] = [];
                    const wantsReplace = isDraft && (validatedArgs as any).replaceThreadDrafts === true;
                    if (wantsReplace && validatedArgs.threadId) {
                        replacedDrafts = await deleteThreadDrafts(validatedArgs.threadId);
                    }

                    const result = await handleEmailAction(action, validatedArgs);
                    if (replacedDrafts.length > 0 && result.content?.[0]?.type === "text") {
                        const summary = replacedDrafts
                            .map(d => `  - draft ${d.draftId} (message ${d.messageId})`)
                            .join('\n');
                        result.content[0].text += `\n\nReplaced ${replacedDrafts.length} existing draft(s) on this thread:\n${summary}`;
                    }
                    return result;
                }

                case "schedule_email": {
                    const validatedArgs = ScheduleEmailSchema.parse(args);
                    if (validatedArgs.skipQuote) {
                        (validatedArgs as any)._skipQuote = true;
                    }
                    // Stamp the resolved send time onto the raw message as a custom header.
                    // This is what send_due_scheduled_emails reads to decide when to fire;
                    // it is the only piece of scheduling state not carried by the "Scheduled" label.
                    (validatedArgs as any).extraHeaders = {
                        ...(validatedArgs as any).extraHeaders,
                        [SCHEDULED_SEND_HEADER]: new Date(validatedArgs.sendAt).toISOString(),
                    };
                    return await handleEmailAction("schedule", validatedArgs);
                }

                case "list_scheduled_emails": {
                    const validatedArgs = ListScheduledEmailsSchema.parse(args);
                    const scheduled = await fetchScheduledDrafts(gmail, validatedArgs.maxResults);
                    if (scheduled.length === 0) {
                        return { content: [{ type: "text", text: "No emails currently scheduled." }] };
                    }
                    const text = scheduled.map(s =>
                        `Draft ID: ${s.draftId}\nSend at: ${s.sendAt || '(unparseable/missing X-Scheduled-Send-At header)'}\nTo: ${s.to}\nSubject: ${s.subject}\n`
                    ).join('\n');
                    return {
                        content: [
                            {
                                type: "text",
                                text: `${scheduled.length} scheduled email(s):\n\n${text}`,
                            },
                        ],
                    };
                }

                case "cancel_scheduled_email": {
                    const validatedArgs = CancelScheduledEmailSchema.parse(args);
                    const result = await cancelScheduledEmail(gmail, validatedArgs);
                    const text = result.action === "deleted"
                        ? `Scheduled email ${result.draftId} permanently deleted.`
                        : `Scheduled email ${result.draftId} unscheduled: the "Scheduled" label was removed and it is now a normal editable draft that will not auto-send.`;
                    return { content: [{ type: "text", text }] };
                }

                case "send_due_scheduled_emails": {
                    SendDueScheduledEmailsSchema.parse(args);
                    const result = await sendDueScheduledEmails(gmail);
                    const lines = [
                        `Sent: ${result.sent.length}`,
                        ...result.sent.map(s => `  - ${s.draftId} -> ${s.to} "${s.subject}" (was due ${s.sendAt})`),
                        `Still pending: ${result.stillPending.length}`,
                        ...result.stillPending.map(s => `  - ${s.draftId} -> ${s.to} "${s.subject}" (due ${s.sendAt || 'unknown'})`),
                        `Errors: ${result.errors.length}`,
                        ...result.errors.map(e => `  - ${e.draftId}: ${e.error}`),
                    ];
                    return { content: [{ type: "text", text: lines.join('\n') }] };
                }

                case "read_email": {
                    const validatedArgs = ReadEmailSchema.parse(args);
                    const response = await withTimeout(gmail.users.messages.get({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        format: 'full',
                    }), DEFAULT_TIMEOUT_MS, 'messages.get read_email');

                    const { subject, from, to, date, rfcMessageId } = extractHeaders(response.data.payload);
                    const threadId = response.data.threadId || '';
                    const { text, html } = extractEmailContent(response.data.payload as GmailMessagePart || {});
                    const attachments = extractAttachments(response.data.payload as GmailMessagePart);

                    // Use plain text content if available, otherwise use HTML content
                    const body = text || html || '';
                    const contentTypeNote = !text && html ?
                        '[Note: This email is HTML-formatted. Plain text version not available.]\n\n' : '';

                    // Add attachment info to output if any are present
                    const attachmentInfo = attachments.length > 0 ?
                        `\n\nAttachments (${attachments.length}):\n` +
                        attachments.map(a => `- ${a.filename} (${a.mimeType}, ${Math.round(a.size/1024)} KB, ID: ${a.id})`).join('\n') : '';

                    // Security-relevant headers (phishing / list detection) and the actual link targets.
                    const securityInfo = formatSecurityHeaders(response.data.payload?.headers || []);
                    const linkInfo = formatLinks(text, html);

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Thread ID: ${threadId}\nMessage-ID: ${rfcMessageId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}\nDate: ${date}${securityInfo}\n\n${contentTypeNote}${body}${attachmentInfo}${linkInfo}`,
                            },
                        ],
                    };
                }

                case "search_emails": {
                    const validatedArgs = SearchEmailsSchema.parse(args);
                    const response = await withTimeout(gmail.users.messages.list({
                        userId: 'me',
                        q: validatedArgs.query,
                        maxResults: validatedArgs.maxResults || 10,
                    }), DEFAULT_TIMEOUT_MS, 'messages.list search');

                    const messages = response.data.messages || [];
                    const results = await Promise.all(
                        messages.map(async (msg) => {
                            const detail = await withTimeout(gmail.users.messages.get({
                                userId: 'me',
                                id: msg.id!,
                                format: 'metadata',
                                metadataHeaders: ['Subject', 'From', 'Date'],
                            }), DEFAULT_TIMEOUT_MS, `messages.get metadata ${msg.id}`);
                            const headers = detail.data.payload?.headers || [];
                            return {
                                id: msg.id,
                                subject: headers.find(h => h.name === 'Subject')?.value || '',
                                from: headers.find(h => h.name === 'From')?.value || '',
                                date: headers.find(h => h.name === 'Date')?.value || '',
                            };
                        })
                    );

                    return {
                        content: [
                            {
                                type: "text",
                                text: results.map(r =>
                                    `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`
                                ).join('\n'),
                            },
                        ],
                    };
                }

                case "download_email": {
                    const validatedArgs = DownloadEmailSchema.parse(args);
                    const { messageId, savePath, format } = validatedArgs;

                    try {
                        // Ensure save directory exists
                        if (!fs.existsSync(savePath)) {
                            fs.mkdirSync(savePath, { recursive: true });
                        }

                        // Always fetch full message for metadata (needed for attachments list)
                        const fullResponse = await withTimeout(gmail.users.messages.get({
                            userId: "me",
                            id: messageId,
                            format: "full",
                        }), DEFAULT_TIMEOUT_MS, 'messages.get download full');

                        const { subject, from, date } = extractHeaders(fullResponse.data.payload);
                        const attachments = extractAttachments(fullResponse.data.payload as GmailMessagePart);

                        let content: string;

                        if (format === "eml") {
                            // For EML format, fetch raw RFC822 message
                            const rawResponse = await withTimeout(gmail.users.messages.get({
                                userId: "me",
                                id: messageId,
                                format: "raw",
                            }), DEFAULT_TIMEOUT_MS, 'messages.get download raw');
                            content = Buffer.from(rawResponse.data.raw || "", "base64url").toString("utf-8");
                        } else {
                            // Extract email content for json/txt/html
                            const emailContent = extractEmailContent(fullResponse.data.payload as GmailMessagePart || {});

                            if (format === "json") {
                                const jsonData = gmailMessageToJson(fullResponse.data, emailContent, attachments);
                                content = JSON.stringify(jsonData, null, 2);
                            } else if (format === "txt") {
                                content = emailToTxt(fullResponse.data, emailContent, attachments);
                            } else {
                                // html - just return the raw HTML content
                                content = emailToHtml(emailContent);
                            }
                        }

                        // Write file
                        const filename = `${messageId}.${format}`;
                        const fullPath = path.join(savePath, filename);
                        fs.writeFileSync(fullPath, content, "utf-8");
                        const stats = fs.statSync(fullPath);

                        // Return metadata with attachments
                        const result = {
                            status: "saved",
                            path: fullPath,
                            size: stats.size,
                            messageId,
                            subject,
                            from,
                            date,
                            attachments,
                        };

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(result, null, 2),
                                },
                            ],
                        };
                    } catch (error: any) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Failed to download email: ${error.message}`,
                                },
                            ],
                        };
                    }
                }

                // Updated implementation for the modify_email handler
                case "modify_email": {
                    const validatedArgs = ModifyEmailSchema.parse(args);
                    
                    // Prepare request body
                    const requestBody: any = {};
                    
                    if (validatedArgs.labelIds) {
                        requestBody.addLabelIds = validatedArgs.labelIds;
                    }
                    
                    if (validatedArgs.addLabelIds) {
                        requestBody.addLabelIds = validatedArgs.addLabelIds;
                    }
                    
                    if (validatedArgs.removeLabelIds) {
                        requestBody.removeLabelIds = validatedArgs.removeLabelIds;
                    }
                    
                    await withTimeout(gmail.users.messages.modify({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        requestBody: requestBody,
                    }), DEFAULT_TIMEOUT_MS, 'messages.modify');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email ${validatedArgs.messageId} labels updated successfully`,
                            },
                        ],
                    };
                }

                case "delete_email": {
                    const validatedArgs = DeleteEmailSchema.parse(args);
                    try {
                        await withTimeout(gmail.users.messages.delete({
                            userId: 'me',
                            id: validatedArgs.messageId,
                        }), DEFAULT_TIMEOUT_MS, 'messages.delete');
                    } catch (err: any) {
                        const status = err?.code ?? err?.response?.status;
                        const msg = String(err?.message ?? '');
                        // messages.delete needs the full https://mail.google.com/ scope. With only
                        // gmail.modify, fall back to trashing so the caller still gets the message
                        // out of the way instead of a hard failure.
                        if (status === 403 || /insufficient permission/i.test(msg)) {
                            await withTimeout(gmail.users.messages.trash({
                                userId: 'me',
                                id: validatedArgs.messageId,
                            }), DEFAULT_TIMEOUT_MS, 'messages.trash');
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Email ${validatedArgs.messageId} moved to Trash (permanent delete requires the full mail.google.com scope, which is not authorized)`,
                                    },
                                ],
                            };
                        }
                        throw err;
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email ${validatedArgs.messageId} deleted successfully`,
                            },
                        ],
                    };
                }

                case "delete_draft": {
                    const validatedArgs = DeleteDraftSchema.parse(args);
                    let draftId = validatedArgs.draftId;
                    if (!draftId) {
                        // Resolve the draft ID from the draft's message ID.
                        let pageToken: string | undefined = undefined;
                        do {
                            const page: any = await withTimeout(gmail.users.drafts.list({
                                userId: 'me',
                                maxResults: 100,
                                pageToken,
                            }), DEFAULT_TIMEOUT_MS, 'drafts.list');
                            const match = (page.data.drafts || []).find((d: any) => d.message?.id === validatedArgs.messageId);
                            if (match) { draftId = match.id; break; }
                            pageToken = page.data.nextPageToken || undefined;
                        } while (pageToken);
                        if (!draftId) {
                            throw new Error(`No draft found with message ID ${validatedArgs.messageId}`);
                        }
                    }
                    await withTimeout(gmail.users.drafts.delete({
                        userId: 'me',
                        id: draftId,
                    }), DEFAULT_TIMEOUT_MS, 'drafts.delete');
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Draft ${draftId} deleted successfully`,
                            },
                        ],
                    };
                }

                case "list_email_labels": {
                    const labelResults = await listLabels(gmail);
                    const systemLabels = labelResults.system;
                    const userLabels = labelResults.user;

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${labelResults.count.total} labels (${labelResults.count.system} system, ${labelResults.count.user} user):\n\n` +
                                    "System Labels:\n" +
                                    systemLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join('\n') +
                                    "\nUser Labels:\n" +
                                    userLabels.map((l: GmailLabel) => `ID: ${l.id}\nName: ${l.name}\n`).join('\n')
                            },
                        ],
                    };
                }

                case "batch_modify_emails": {
                    const validatedArgs = BatchModifyEmailsSchema.parse(args);
                    const messageIds = validatedArgs.messageIds;
                    const batchSize = validatedArgs.batchSize || 50;
                    
                    // Prepare request body
                    const requestBody: any = {};
                    
                    if (validatedArgs.addLabelIds) {
                        requestBody.addLabelIds = validatedArgs.addLabelIds;
                    }
                    
                    if (validatedArgs.removeLabelIds) {
                        requestBody.removeLabelIds = validatedArgs.removeLabelIds;
                    }

                    // Process messages in batches
                    const { successes, failures } = await processBatches(
                        messageIds,
                        batchSize,
                        async (batch) => {
                            const results = await Promise.all(
                                batch.map(async (messageId) => {
                                    const result = await withTimeout(gmail.users.messages.modify({
                                        userId: 'me',
                                        id: messageId,
                                        requestBody: requestBody,
                                    }), DEFAULT_TIMEOUT_MS, `batch messages.modify ${messageId}`);
                                    return { messageId, success: true };
                                })
                            );
                            return results;
                        }
                    );

                    // Generate summary of the operation
                    const successCount = successes.length;
                    const failureCount = failures.length;
                    
                    let resultText = `Batch label modification complete.\n`;
                    resultText += `Successfully processed: ${successCount} messages\n`;
                    
                    if (failureCount > 0) {
                        resultText += `Failed to process: ${failureCount} messages\n\n`;
                        resultText += `Failed message IDs:\n`;
                        resultText += failures.map(f => `- ${(f.item as string).substring(0, 16)}... (${f.error.message})`).join('\n');
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: resultText,
                            },
                        ],
                    };
                }

                case "batch_delete_emails": {
                    const validatedArgs = BatchDeleteEmailsSchema.parse(args);
                    const messageIds = validatedArgs.messageIds;
                    const batchSize = validatedArgs.batchSize || 50;

                    // Process messages in batches
                    const { successes, failures } = await processBatches(
                        messageIds,
                        batchSize,
                        async (batch) => {
                            const results = await Promise.all(
                                batch.map(async (messageId) => {
                                    try {
                                        await withTimeout(gmail.users.messages.delete({
                                            userId: 'me',
                                            id: messageId,
                                        }), DEFAULT_TIMEOUT_MS, `batch messages.delete ${messageId}`);
                                    } catch (err: any) {
                                        const status = err?.code ?? err?.response?.status;
                                        if (status === 403 || /insufficient permission/i.test(String(err?.message ?? ''))) {
                                            // Same fallback as delete_email: trash when permanent delete is out of scope.
                                            await withTimeout(gmail.users.messages.trash({
                                                userId: 'me',
                                                id: messageId,
                                            }), DEFAULT_TIMEOUT_MS, `batch messages.trash ${messageId}`);
                                        } else {
                                            throw err;
                                        }
                                    }
                                    return { messageId, success: true };
                                })
                            );
                            return results;
                        }
                    );

                    // Generate summary of the operation
                    const successCount = successes.length;
                    const failureCount = failures.length;
                    
                    let resultText = `Batch delete operation complete.\n`;
                    resultText += `Successfully deleted: ${successCount} messages\n`;
                    
                    if (failureCount > 0) {
                        resultText += `Failed to delete: ${failureCount} messages\n\n`;
                        resultText += `Failed message IDs:\n`;
                        resultText += failures.map(f => `- ${(f.item as string).substring(0, 16)}... (${f.error.message})`).join('\n');
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: resultText,
                            },
                        ],
                    };
                }

                // New label management handlers
                case "create_label": {
                    const validatedArgs = CreateLabelSchema.parse(args);
                    const result = await createLabel(gmail, validatedArgs.name, {
                        messageListVisibility: validatedArgs.messageListVisibility,
                        labelListVisibility: validatedArgs.labelListVisibility,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Label created successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                            },
                        ],
                    };
                }

                case "update_label": {
                    const validatedArgs = UpdateLabelSchema.parse(args);
                    
                    // Prepare request body with only the fields that were provided
                    const updates: any = {};
                    if (validatedArgs.name) updates.name = validatedArgs.name;
                    if (validatedArgs.messageListVisibility) updates.messageListVisibility = validatedArgs.messageListVisibility;
                    if (validatedArgs.labelListVisibility) updates.labelListVisibility = validatedArgs.labelListVisibility;
                    
                    const result = await updateLabel(gmail, validatedArgs.id, updates);

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Label updated successfully:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                            },
                        ],
                    };
                }

                case "delete_label": {
                    const validatedArgs = DeleteLabelSchema.parse(args);
                    const result = await deleteLabel(gmail, validatedArgs.id);

                    return {
                        content: [
                            {
                                type: "text",
                                text: result.message,
                            },
                        ],
                    };
                }

                case "get_or_create_label": {
                    const validatedArgs = GetOrCreateLabelSchema.parse(args);
                    const result = await getOrCreateLabel(gmail, validatedArgs.name, {
                        messageListVisibility: validatedArgs.messageListVisibility,
                        labelListVisibility: validatedArgs.labelListVisibility,
                    });

                    const action = result.type === 'user' && result.name === validatedArgs.name ? 'found existing' : 'created new';
                    
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Successfully ${action} label:\nID: ${result.id}\nName: ${result.name}\nType: ${result.type}`,
                            },
                        ],
                    };
                }


                // Filter management handlers
                case "create_filter": {
                    const validatedArgs = CreateFilterSchema.parse(args);
                    const result = await createFilter(gmail, validatedArgs.criteria, validatedArgs.action);

                    // Format criteria for display
                    const criteriaText = Object.entries(validatedArgs.criteria)
                        .filter(([_, value]) => value !== undefined)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(', ');

                    // Format actions for display
                    const actionText = Object.entries(validatedArgs.action)
                        .filter(([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
                        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                        .join(', ');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Filter created successfully:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
                            },
                        ],
                    };
                }

                case "list_filters": {
                    const result = await listFilters(gmail);
                    const filters = result.filters;

                    if (filters.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No filters found.",
                                },
                            ],
                        };
                    }

                    const filtersText = filters.map((filter: any) => {
                        const criteriaEntries = Object.entries(filter.criteria || {})
                            .filter(([_, value]) => value !== undefined)
                            .map(([key, value]) => `${key}: ${value}`)
                            .join(', ');
                        
                        const actionEntries = Object.entries(filter.action || {})
                            .filter(([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
                            .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                            .join(', ');

                        return `ID: ${filter.id}\nCriteria: ${criteriaEntries}\nActions: ${actionEntries}\n`;
                    }).join('\n');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${result.count} filters:\n\n${filtersText}`,
                            },
                        ],
                    };
                }

                case "get_filter": {
                    const validatedArgs = GetFilterSchema.parse(args);
                    const result = await getFilter(gmail, validatedArgs.filterId);

                    const criteriaText = Object.entries(result.criteria || {})
                        .filter(([_, value]) => value !== undefined)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(', ');
                    
                    const actionText = Object.entries(result.action || {})
                        .filter(([_, value]) => value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
                        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                        .join(', ');

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Filter details:\nID: ${result.id}\nCriteria: ${criteriaText}\nActions: ${actionText}`,
                            },
                        ],
                    };
                }

                case "delete_filter": {
                    const validatedArgs = DeleteFilterSchema.parse(args);
                    const result = await deleteFilter(gmail, validatedArgs.filterId);

                    return {
                        content: [
                            {
                                type: "text",
                                text: result.message,
                            },
                        ],
                    };
                }

                case "create_filter_from_template": {
                    const validatedArgs = CreateFilterFromTemplateSchema.parse(args);
                    const template = validatedArgs.template;
                    const params = validatedArgs.parameters;

                    let filterConfig;
                    
                    switch (template) {
                        case 'fromSender':
                            if (!params.senderEmail) throw new Error("senderEmail is required for fromSender template");
                            filterConfig = filterTemplates.fromSender(params.senderEmail, params.labelIds, params.archive);
                            break;
                        case 'withSubject':
                            if (!params.subjectText) throw new Error("subjectText is required for withSubject template");
                            filterConfig = filterTemplates.withSubject(params.subjectText, params.labelIds, params.markAsRead);
                            break;
                        case 'withAttachments':
                            filterConfig = filterTemplates.withAttachments(params.labelIds);
                            break;
                        case 'largeEmails':
                            if (!params.sizeInBytes) throw new Error("sizeInBytes is required for largeEmails template");
                            filterConfig = filterTemplates.largeEmails(params.sizeInBytes, params.labelIds);
                            break;
                        case 'containingText':
                            if (!params.searchText) throw new Error("searchText is required for containingText template");
                            filterConfig = filterTemplates.containingText(params.searchText, params.labelIds, params.markImportant);
                            break;
                        case 'mailingList':
                            if (!params.listIdentifier) throw new Error("listIdentifier is required for mailingList template");
                            filterConfig = filterTemplates.mailingList(params.listIdentifier, params.labelIds, params.archive);
                            break;
                        default:
                            throw new Error(`Unknown template: ${template}`);
                    }

                    const result = await createFilter(gmail, filterConfig.criteria, filterConfig.action);

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Filter created from template '${template}':\nID: ${result.id}\nTemplate used: ${template}`,
                            },
                        ],
                    };
                }
                case "download_attachment": {
                    const validatedArgs = DownloadAttachmentSchema.parse(args);
                    const mode = validatedArgs.mode || 'auto';

                    try {
                        // Always fetch the message so we know the attachment's original filename and mimeType,
                        // regardless of mode (auto/text/base64 need mimeType to decide extraction; file needs
                        // a sensible default filename).
                        const messageResponse = await withTimeout(gmail.users.messages.get({
                            userId: 'me',
                            id: validatedArgs.messageId,
                            format: 'full',
                        }), DEFAULT_TIMEOUT_MS, 'messages.get attachment metadata');

                        // Get the attachment data from Gmail API
                        const attachmentResponse = await withTimeout(gmail.users.messages.attachments.get({
                            userId: 'me',
                            messageId: validatedArgs.messageId,
                            id: validatedArgs.attachmentId,
                        }), 60_000, 'attachments.get');

                        if (!attachmentResponse.data.data) {
                            throw new Error('No attachment data received');
                        }

                        // Decode the base64 data
                        const data = attachmentResponse.data.data;
                        const buffer = Buffer.from(data, 'base64url');

                        // Resolve the attachment's original filename and mimeType. Gmail attachment IDs are
                        // NOT stable between API calls, so an exact ID match against a fresh messages.get
                        // often fails; fall back to a unique byte-size match, then to caller-supplied hints.
                        type PartMeta = { filename: string; mimeType: string; size: number; attachmentId: string };
                        const parts: PartMeta[] = [];
                        const collectParts = (part: any) => {
                            if (part?.body?.attachmentId) {
                                parts.push({
                                    filename: part.filename || '',
                                    mimeType: part.mimeType || 'application/octet-stream',
                                    size: Number(part.body.size) || 0,
                                    attachmentId: part.body.attachmentId,
                                });
                            }
                            if (part?.parts) part.parts.forEach(collectParts);
                        };
                        collectParts(messageResponse.data.payload);

                        let found: { filename: string; mimeType: string } | null =
                            parts.find(p => p.attachmentId === validatedArgs.attachmentId) || null;
                        if (!found) {
                            const bySize = parts.filter(p => p.size === buffer.length);
                            if (bySize.length === 1) found = bySize[0];
                            else if (bySize.length > 1 && validatedArgs.filename) {
                                found = bySize.find(p => p.filename === validatedArgs.filename) || bySize[0];
                            }
                        }
                        const originalMimeType = validatedArgs.mimeType || found?.mimeType || 'application/octet-stream';
                        let filename = validatedArgs.filename || found?.filename || '';
                        if (!filename) {
                            const ext = mimeExtension(originalMimeType);
                            filename = `attachment-${validatedArgs.attachmentId.slice(0, 24)}${ext ? `.${ext}` : ''}`;
                        }

                        if (mode === 'file') {
                            // Legacy behavior: save to server disk.
                            const savePath = validatedArgs.savePath || process.cwd();

                            // Sanitize filename to prevent path traversal
                            const safeFilename = path.basename(filename);

                            // Ensure save directory exists
                            if (!fs.existsSync(savePath)) {
                                fs.mkdirSync(savePath, { recursive: true });
                            }

                            // Resolve and validate final path stays within savePath
                            const resolvedSavePath = path.resolve(savePath);
                            const fullPath = path.resolve(resolvedSavePath, safeFilename);
                            if (!fullPath.startsWith(resolvedSavePath + path.sep) && fullPath !== resolvedSavePath) {
                                throw new Error('Invalid filename: path traversal detected');
                            }
                            fs.writeFileSync(fullPath, buffer);

                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Attachment downloaded successfully:\nFile: ${safeFilename}\nSize: ${buffer.length} bytes\nSaved to: ${fullPath}`,
                                    },
                                ],
                            };
                        }

                        // Inline modes: auto, text, base64.
                        const maxBytes = validatedArgs.maxBytes || 10 * 1024 * 1024;
                        if (buffer.length > maxBytes) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Attachment "${filename}" is ${buffer.length} bytes, exceeding the ${maxBytes} byte inline limit for mode='${mode}'. Retry with a larger maxBytes, or use mode='file' to save it to disk on the server instead.`,
                                    },
                                ],
                            };
                        }

                        // Both 'text' and 'auto' attempt extraction first; 'auto' falls back to base64
                        // below when the type isn't extractable, while 'text' errors instead.
                        // 'base64' skips extraction entirely.
                        if (mode === 'text' || mode === 'auto') {
                            const extracted = await extractAttachmentText(buffer, originalMimeType, filename);
                            if (extracted) {
                                return {
                                    content: [
                                        {
                                            type: "text",
                                            text: `Attachment: ${filename}\nType: ${originalMimeType}\nSize: ${buffer.length} bytes\nMode: text (${extracted.kind})\n\n${extracted.text}`,
                                        },
                                    ],
                                };
                            }

                            if (mode === 'text') {
                                return {
                                    content: [
                                        {
                                            type: "text",
                                            text: `Cannot extract text from "${filename}" (type: ${originalMimeType}). Supported types: application/pdf, DOCX, XLSX/XLS, CSV, TXT/MD/JSON, HTML. Use mode='base64' or mode='file' instead.`,
                                        },
                                    ],
                                };
                            }
                            // mode === 'auto' and not extractable: fall through to base64 below.
                        }

                        const base64Payload = {
                            filename,
                            mimeType: originalMimeType,
                            size: buffer.length,
                            contentBase64: buffer.toString('base64'),
                        };
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify(base64Payload),
                                },
                            ],
                            structuredContent: base64Payload,
                        };
                    } catch (error: any) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Failed to download attachment: ${error.message}`,
                                },
                            ],
                        };
                    }
                }

                case "get_thread": {
                    const validatedArgs = GetThreadSchema.parse(args);
                    const threadResponse = await withTimeout(gmail.users.threads.get({
                        userId: 'me',
                        id: validatedArgs.threadId,
                        format: validatedArgs.format || 'full',
                    }), DEFAULT_TIMEOUT_MS, 'threads.get');

                    const threadMessages = threadResponse.data.messages || [];

                    // Process each message in the thread (already chronological from API)
                    const messagesOutput = threadMessages.map((msg) => {
                        const headers = msg.payload?.headers || [];
                        const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';
                        const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
                        const to = headers.find(h => h.name?.toLowerCase() === 'to')?.value || '';
                        const cc = headers.find(h => h.name?.toLowerCase() === 'cc')?.value || '';
                        const bcc = headers.find(h => h.name?.toLowerCase() === 'bcc')?.value || '';
                        const date = headers.find(h => h.name?.toLowerCase() === 'date')?.value || '';

                        // Extract body content
                        let body = '';
                        if (validatedArgs.format !== 'minimal') {
                            const { text, html } = extractEmailContent(msg.payload as GmailMessagePart || {});
                            body = text || html || '';
                        }

                        // Extract attachment metadata
                        const attachments: EmailAttachment[] = [];
                        const processAttachmentParts = (part: GmailMessagePart) => {
                            if (part.body && part.body.attachmentId) {
                                const filename = part.filename || `attachment-${part.body.attachmentId}`;
                                attachments.push({
                                    id: part.body.attachmentId,
                                    filename: filename,
                                    mimeType: part.mimeType || 'application/octet-stream',
                                    size: part.body.size || 0,
                                });
                            }
                            if (part.parts) {
                                part.parts.forEach((subpart: GmailMessagePart) => processAttachmentParts(subpart));
                            }
                        };
                        if (msg.payload) {
                            processAttachmentParts(msg.payload as GmailMessagePart);
                        }

                        return {
                            messageId: msg.id || '',
                            threadId: msg.threadId || '',
                            from,
                            to,
                            cc,
                            bcc,
                            subject,
                            date,
                            body,
                            labelIds: msg.labelIds || [],
                            attachments: attachments.map(a => ({
                                filename: a.filename,
                                mimeType: a.mimeType,
                                size: a.size,
                            })),
                        };
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    threadId: validatedArgs.threadId,
                                    messageCount: messagesOutput.length,
                                    messages: messagesOutput,
                                }, null, 2),
                            },
                        ],
                    };
                }

                case "list_inbox_threads": {
                    const validatedArgs = ListInboxThreadsSchema.parse(args);
                    const threadsResponse = await withTimeout(gmail.users.threads.list({
                        userId: 'me',
                        q: validatedArgs.query || 'in:inbox',
                        maxResults: validatedArgs.maxResults || 50,
                    }), DEFAULT_TIMEOUT_MS, 'threads.list inbox');

                    const threads = threadsResponse.data.threads || [];

                    // Fetch metadata for each thread to get message count and latest message info
                    const threadDetails = await Promise.all(
                        threads.map(async (thread) => {
                            const detail = await withTimeout(gmail.users.threads.get({
                                userId: 'me',
                                id: thread.id!,
                                format: 'metadata',
                                metadataHeaders: ['Subject', 'From', 'Date'],
                            }), DEFAULT_TIMEOUT_MS, `threads.get metadata ${thread.id}`);

                            const messages = detail.data.messages || [];
                            const latestMessage = messages[messages.length - 1];
                            const latestHeaders = latestMessage?.payload?.headers || [];

                            return {
                                threadId: thread.id || '',
                                snippet: thread.snippet || '',
                                historyId: thread.historyId || '',
                                messageCount: messages.length,
                                latestMessage: {
                                    from: latestHeaders.find(h => h.name === 'From')?.value || '',
                                    subject: latestHeaders.find(h => h.name === 'Subject')?.value || '',
                                    date: latestHeaders.find(h => h.name === 'Date')?.value || '',
                                },
                            };
                        })
                    );

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    resultCount: threadDetails.length,
                                    threads: threadDetails,
                                }, null, 2),
                            },
                        ],
                    };
                }

                case "get_inbox_with_threads": {
                    const validatedArgs = GetInboxWithThreadsSchema.parse(args);
                    const threadsResponse = await withTimeout(gmail.users.threads.list({
                        userId: 'me',
                        q: validatedArgs.query || 'in:inbox',
                        maxResults: validatedArgs.maxResults || 50,
                    }), DEFAULT_TIMEOUT_MS, 'threads.list get_inbox');

                    const threads = threadsResponse.data.threads || [];

                    if (!validatedArgs.expandThreads) {
                        // Return basic thread list without expansion (same as list_inbox_threads)
                        const threadSummaries = await Promise.all(
                            threads.map(async (thread) => {
                                const detail = await withTimeout(gmail.users.threads.get({
                                    userId: 'me',
                                    id: thread.id!,
                                    format: 'metadata',
                                    metadataHeaders: ['Subject', 'From', 'Date'],
                                }), DEFAULT_TIMEOUT_MS, `threads.get summary ${thread.id}`);

                                const messages = detail.data.messages || [];
                                const latestMessage = messages[messages.length - 1];
                                const latestHeaders = latestMessage?.payload?.headers || [];

                                return {
                                    threadId: thread.id || '',
                                    snippet: thread.snippet || '',
                                    historyId: thread.historyId || '',
                                    messageCount: messages.length,
                                    latestMessage: {
                                        from: latestHeaders.find(h => h.name === 'From')?.value || '',
                                        subject: latestHeaders.find(h => h.name === 'Subject')?.value || '',
                                        date: latestHeaders.find(h => h.name === 'Date')?.value || '',
                                    },
                                };
                            })
                        );

                        return {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify({
                                        resultCount: threadSummaries.length,
                                        threads: threadSummaries,
                                    }, null, 2),
                                },
                            ],
                        };
                    }

                    // Expand each thread with full message content (parallel fetch)
                    const expandedThreads = await Promise.all(
                        threads.map(async (thread) => {
                            const threadDetail = await withTimeout(gmail.users.threads.get({
                                userId: 'me',
                                id: thread.id!,
                                format: 'full',
                            }), DEFAULT_TIMEOUT_MS, `threads.get expand ${thread.id}`);

                            const threadMessages = threadDetail.data.messages || [];

                            const messages = threadMessages.map((msg) => {
                                const headers = msg.payload?.headers || [];
                                const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';
                                const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
                                const to = headers.find(h => h.name?.toLowerCase() === 'to')?.value || '';
                                const cc = headers.find(h => h.name?.toLowerCase() === 'cc')?.value || '';
                                const bcc = headers.find(h => h.name?.toLowerCase() === 'bcc')?.value || '';
                                const date = headers.find(h => h.name?.toLowerCase() === 'date')?.value || '';

                                const { text, html } = extractEmailContent(msg.payload as GmailMessagePart || {});
                                const body = text || html || '';

                                // Extract attachment metadata
                                const attachments: EmailAttachment[] = [];
                                const processAttachmentParts = (part: GmailMessagePart) => {
                                    if (part.body && part.body.attachmentId) {
                                        const filename = part.filename || `attachment-${part.body.attachmentId}`;
                                        attachments.push({
                                            id: part.body.attachmentId,
                                            filename: filename,
                                            mimeType: part.mimeType || 'application/octet-stream',
                                            size: part.body.size || 0,
                                        });
                                    }
                                    if (part.parts) {
                                        part.parts.forEach((subpart: GmailMessagePart) => processAttachmentParts(subpart));
                                    }
                                };
                                if (msg.payload) {
                                    processAttachmentParts(msg.payload as GmailMessagePart);
                                }

                                return {
                                    messageId: msg.id || '',
                                    threadId: msg.threadId || '',
                                    from,
                                    to,
                                    cc,
                                    bcc,
                                    subject,
                                    date,
                                    body,
                                    labelIds: msg.labelIds || [],
                                    attachments: attachments.map(a => ({
                                        filename: a.filename,
                                        mimeType: a.mimeType,
                                        size: a.size,
                                    })),
                                };
                            });

                            return {
                                threadId: thread.id || '',
                                messageCount: messages.length,
                                messages,
                            };
                        })
                    );

                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    resultCount: expandedThreads.length,
                                    threads: expandedThreads,
                                }, null, 2),
                            },
                        ],
                    };
                }

                case "reply_all": {
                    const validatedArgs = ReplyAllSchema.parse(args);

                    // Fetch the original email to get headers
                    const originalEmail = await withTimeout(gmail.users.messages.get({
                        userId: 'me',
                        id: validatedArgs.messageId,
                        format: 'full',
                    }), DEFAULT_TIMEOUT_MS, 'messages.get reply_all');

                    const headers = originalEmail.data.payload?.headers || [];
                    const threadId = originalEmail.data.threadId || '';

                    // Extract relevant headers
                    const originalFrom = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
                    const originalTo = headers.find(h => h.name?.toLowerCase() === 'to')?.value || '';
                    const originalCc = headers.find(h => h.name?.toLowerCase() === 'cc')?.value || '';
                    const originalSubject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';
                    const originalMessageId = headers.find(h => h.name?.toLowerCase() === 'message-id')?.value || '';
                    const originalReferences = headers.find(h => h.name?.toLowerCase() === 'references')?.value || '';

                    // Get authenticated user's email to exclude from recipients
                    const profile = await withTimeout(gmail.users.getProfile({ userId: 'me' }), DEFAULT_TIMEOUT_MS, 'getProfile');
                    const myEmail = profile.data.emailAddress?.toLowerCase() || '';

                    // Build recipient list using helper functions
                    const { to: replyTo, cc: replyCc } = buildReplyAllRecipients(
                        originalFrom,
                        originalTo,
                        originalCc,
                        myEmail
                    );

                    if (replyTo.length === 0) {
                        throw new Error('Could not determine recipient for reply');
                    }

                    // Build subject with "Re:" prefix if not already present
                    const replySubject = addRePrefix(originalSubject);

                    // Build References header (original References + original Message-ID)
                    const references = buildReferencesHeader(originalReferences, originalMessageId);

                    // Prepare the email arguments for handleEmailAction
                    const emailArgs = {
                        to: replyTo,
                        cc: replyCc.length > 0 ? replyCc : undefined,
                        subject: replySubject,
                        body: validatedArgs.body,
                        htmlBody: validatedArgs.htmlBody,
                        mimeType: validatedArgs.mimeType,
                        threadId: threadId,
                        inReplyTo: originalMessageId,
                        attachments: validatedArgs.attachments,
                    };

                    // Use the existing handleEmailAction to send the reply
                    const result = await handleEmailAction("send", emailArgs);

                    // Enhance the response with reply-all specific info
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Reply-all sent successfully!\nTo: ${replyTo.join(', ')}${replyCc.length > 0 ? `\nCC: ${replyCc.join(', ')}` : ''}\nSubject: ${replySubject}\nThread ID: ${threadId}`,
                            },
                        ],
                    };
                }

                case "search_contacts": {
                    const validatedArgs = SearchContactsSchema.parse(args);
                    const result = await searchContacts(oauth2Client, {
                        query: validatedArgs.query,
                        maxResults: validatedArgs.maxResults,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(result, null, 2),
                            },
                        ],
                        structuredContent: result,
                    };
                }

                case "get_contact_photo": {
                    const validatedArgs = GetContactPhotoSchema.parse(args);
                    const result = await getContactPhoto(oauth2Client, {
                        email: validatedArgs.email,
                        size: validatedArgs.size,
                        mode: validatedArgs.mode,
                    });
                    // Mirrors download_attachment: the full payload goes in both the text
                    // block and structuredContent, since not every client reads the latter.
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(result),
                            },
                        ],
                        structuredContent: result,
                    };
                }

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        } catch (error: any) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error: ${error.message}`,
                    },
                ],
            };
        }
    });

    const transport = new StdioServerTransport();
    server.connect(transport);
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});
