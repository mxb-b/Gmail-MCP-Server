/**
 * Tests for scheduled send (task #17: schedule-send + visibility of scheduled emails)
 *
 * Covers:
 * 1. ScheduleEmailSchema validation (future-time requirement, field passthrough)
 * 2. ListScheduledEmailsSchema / CancelScheduledEmailSchema validation
 * 3. createEmailMessage carries extraHeaders onto the raw MIME message
 * 4. scheduled-send.ts logic (fetchScheduledDrafts, markDraftScheduled,
 *    cancelScheduledEmail, sendDueScheduledEmails) against a mock Gmail client
 * 5. Tool registry: the four new tools are registered with sane scopes
 */

import { describe, it, expect, vi } from 'vitest';
import {
    ScheduleEmailSchema,
    ListScheduledEmailsSchema,
    CancelScheduledEmailSchema,
    SendDueScheduledEmailsSchema,
    toolDefinitions,
    getToolByName,
} from './tools.js';
import { createEmailMessage } from './utl.js';
import {
    fetchScheduledDrafts,
    markDraftScheduled,
    cancelScheduledEmail,
    sendDueScheduledEmails,
    SCHEDULED_LABEL_NAME,
    SCHEDULED_SEND_HEADER,
} from './scheduled-send.js';

function getHeader(raw: string, headerName: string): string | null {
    const regex = new RegExp(`^${headerName}:\\s*(.+)$`, 'mi');
    const match = raw.match(regex);
    return match ? match[1].trim() : null;
}

describe('ScheduleEmailSchema', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const base = { to: ['a@example.com'], subject: 'Hi', body: 'Body' };

    it('parses with a valid future sendAt', () => {
        const result = ScheduleEmailSchema.parse({ ...base, sendAt: future });
        expect(result.sendAt).toBe(future);
        expect(result.to).toEqual(['a@example.com']);
    });

    it('rejects a sendAt in the past', () => {
        const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        expect(() => ScheduleEmailSchema.parse({ ...base, sendAt: past })).toThrow();
    });

    it('rejects an unparseable sendAt', () => {
        expect(() => ScheduleEmailSchema.parse({ ...base, sendAt: 'not-a-date' })).toThrow();
    });

    it('rejects a missing sendAt', () => {
        expect(() => ScheduleEmailSchema.parse(base)).toThrow();
    });

    it('still requires the base SendEmailSchema fields', () => {
        expect(() => ScheduleEmailSchema.parse({ sendAt: future })).toThrow();
    });
});

describe('ListScheduledEmailsSchema', () => {
    it('defaults maxResults to 50', () => {
        expect(ListScheduledEmailsSchema.parse({}).maxResults).toBe(50);
    });

    it('accepts a custom maxResults', () => {
        expect(ListScheduledEmailsSchema.parse({ maxResults: 5 }).maxResults).toBe(5);
    });
});

describe('CancelScheduledEmailSchema', () => {
    it('accepts draftId alone', () => {
        const r = CancelScheduledEmailSchema.parse({ draftId: 'd1' });
        expect(r.draftId).toBe('d1');
        expect(r.permanentlyDelete).toBe(false);
    });

    it('accepts messageId alone', () => {
        const r = CancelScheduledEmailSchema.parse({ messageId: 'm1' });
        expect(r.messageId).toBe('m1');
    });

    it('rejects when neither draftId nor messageId is given', () => {
        expect(() => CancelScheduledEmailSchema.parse({})).toThrow();
    });

    it('accepts permanentlyDelete: true', () => {
        const r = CancelScheduledEmailSchema.parse({ draftId: 'd1', permanentlyDelete: true });
        expect(r.permanentlyDelete).toBe(true);
    });
});

describe('SendDueScheduledEmailsSchema', () => {
    it('accepts an empty object (no arguments needed)', () => {
        expect(() => SendDueScheduledEmailsSchema.parse({})).not.toThrow();
    });
});

describe('createEmailMessage extraHeaders', () => {
    it('includes extraHeaders on the raw message', () => {
        const raw = createEmailMessage({
            to: ['test@example.com'],
            subject: 'Scheduled test',
            body: 'Body text',
            extraHeaders: { [SCHEDULED_SEND_HEADER]: '2026-09-01T10:00:00.000Z' },
        });
        expect(getHeader(raw, SCHEDULED_SEND_HEADER)).toBe('2026-09-01T10:00:00.000Z');
    });

    it('sanitizes extraHeaders against CRLF injection', () => {
        const raw = createEmailMessage({
            to: ['test@example.com'],
            subject: 'Injection test',
            body: 'Body text',
            extraHeaders: { 'X-Custom': 'value\r\nBcc: attacker@evil.com' },
        });
        // The injected CR/LF is stripped, so "Bcc: attacker@evil.com" is folded into the
        // X-Custom header's value rather than becoming its own header line.
        expect(getHeader(raw, 'Bcc')).toBeNull();
        expect(getHeader(raw, 'X-Custom')).toBe('valueBcc: attacker@evil.com');
    });

    it('omits extraHeaders block entirely when not provided', () => {
        const raw = createEmailMessage({
            to: ['test@example.com'],
            subject: 'No extra headers',
            body: 'Body text',
        });
        expect(getHeader(raw, SCHEDULED_SEND_HEADER)).toBeNull();
    });
});

describe('tool registry: scheduled send tools', () => {
    it('registers schedule_email, list_scheduled_emails, cancel_scheduled_email, send_due_scheduled_emails', () => {
        for (const name of ['schedule_email', 'list_scheduled_emails', 'cancel_scheduled_email', 'send_due_scheduled_emails']) {
            const tool = getToolByName(name);
            expect(tool, `expected ${name} to be registered`).toBeDefined();
        }
    });

    it('schedule_email and send_due_scheduled_emails require a send-capable scope', () => {
        expect(getToolByName('schedule_email')!.scopes).toEqual(expect.arrayContaining(['gmail.compose']));
        expect(getToolByName('send_due_scheduled_emails')!.scopes).toEqual(expect.arrayContaining(['gmail.send']));
    });

    it('list_scheduled_emails is read-only', () => {
        expect(getToolByName('list_scheduled_emails')!.annotations.readOnlyHint).toBe(true);
    });

    it('does not duplicate any existing tool name', () => {
        const names = toolDefinitions.map(t => t.name);
        expect(new Set(names).size).toBe(names.length);
    });
});

// --- Mock Gmail client for scheduled-send.ts logic ---

interface MockLabel { id: string; name: string; type: string }
interface MockDraft { id: string; message: { id: string } }
interface MockMessage {
    id: string;
    labelIds: string[];
    headers: Record<string, string>;
    snippet?: string;
}

function makeMockGmail(opts: { labels?: MockLabel[]; drafts?: MockDraft[]; messages?: Record<string, MockMessage> }) {
    const labels: MockLabel[] = opts.labels ? [...opts.labels] : [];
    const drafts: MockDraft[] = opts.drafts ? [...opts.drafts] : [];
    const messages: Record<string, MockMessage> = opts.messages ? { ...opts.messages } : {};
    const sendCalls: string[] = [];

    const gmail = {
        users: {
            labels: {
                list: vi.fn(async () => ({ data: { labels } })),
                create: vi.fn(async ({ requestBody }: any) => {
                    const label: MockLabel = { id: `label_${labels.length + 1}`, name: requestBody.name, type: 'user' };
                    labels.push(label);
                    return { data: label };
                }),
            },
            drafts: {
                list: vi.fn(async ({ q }: any) => {
                    if (!q) return { data: { drafts } };
                    // Minimal emulation of Gmail's `label:X` search syntax against our mock state.
                    const labelMatch = q.match(/^label:(\S+)$/);
                    if (labelMatch) {
                        const label = labels.find(l => l.name === labelMatch[1]);
                        if (!label) return { data: { drafts: [] } };
                        const matching = drafts.filter(d => messages[d.message.id]?.labelIds.includes(label.id));
                        return { data: { drafts: matching } };
                    }
                    return { data: { drafts } };
                }),
                delete: vi.fn(async ({ id }: any) => {
                    const idx = drafts.findIndex(d => d.id === id);
                    if (idx >= 0) drafts.splice(idx, 1);
                    return { data: {} };
                }),
                send: vi.fn(async ({ requestBody }: any) => {
                    sendCalls.push(requestBody.id);
                    const draft = drafts.find(d => d.id === requestBody.id);
                    const idx = drafts.findIndex(d => d.id === requestBody.id);
                    if (idx >= 0) drafts.splice(idx, 1);
                    return { data: { id: draft ? `sent_${draft.message.id}` : 'sent_unknown' } };
                }),
            },
            messages: {
                get: vi.fn(async ({ id }: any) => {
                    const msg = messages[id];
                    if (!msg) throw new Error(`no such message ${id}`);
                    return {
                        data: {
                            payload: {
                                headers: Object.entries(msg.headers).map(([name, value]) => ({ name, value })),
                            },
                            snippet: msg.snippet || '',
                        },
                    };
                }),
                modify: vi.fn(async ({ id, requestBody }: any) => {
                    const msg = messages[id];
                    if (!msg) throw new Error(`no such message ${id}`);
                    if (requestBody.addLabelIds) {
                        for (const l of requestBody.addLabelIds) if (!msg.labelIds.includes(l)) msg.labelIds.push(l);
                    }
                    if (requestBody.removeLabelIds) {
                        msg.labelIds = msg.labelIds.filter((l: string) => !requestBody.removeLabelIds.includes(l));
                    }
                    return { data: {} };
                }),
            },
        },
    };

    return { gmail, state: { labels, drafts, messages, sendCalls } };
}

describe('markDraftScheduled + fetchScheduledDrafts', () => {
    it('creates the Scheduled label on first use and labels the message', async () => {
        const { gmail, state } = makeMockGmail({
            messages: { m1: { id: 'm1', labelIds: [], headers: {} } },
        });
        const label = await markDraftScheduled(gmail, 'm1');
        expect(label.name).toBe(SCHEDULED_LABEL_NAME);
        expect(state.messages.m1.labelIds).toContain(label.id);
        expect(state.labels.some(l => l.name === SCHEDULED_LABEL_NAME)).toBe(true);
    });

    it('fetchScheduledDrafts returns [] when the Scheduled label does not exist yet', async () => {
        const { gmail } = makeMockGmail({});
        expect(await fetchScheduledDrafts(gmail)).toEqual([]);
    });

    it('fetchScheduledDrafts returns labeled drafts sorted by sendAt ascending', async () => {
        const { gmail } = makeMockGmail({
            labels: [{ id: 'lbl_1', name: SCHEDULED_LABEL_NAME, type: 'user' }],
            drafts: [
                { id: 'draft_late', message: { id: 'msg_late' } },
                { id: 'draft_early', message: { id: 'msg_early' } },
            ],
            messages: {
                msg_late: { id: 'msg_late', labelIds: ['lbl_1'], headers: { Subject: 'Late', To: 'x@example.com', [SCHEDULED_SEND_HEADER]: '2026-12-01T00:00:00.000Z' } },
                msg_early: { id: 'msg_early', labelIds: ['lbl_1'], headers: { Subject: 'Early', To: 'y@example.com', [SCHEDULED_SEND_HEADER]: '2026-09-01T00:00:00.000Z' } },
            },
        });
        const result = await fetchScheduledDrafts(gmail);
        expect(result.map(r => r.draftId)).toEqual(['draft_early', 'draft_late']);
        expect(result[0].sendAt).toBe('2026-09-01T00:00:00.000Z');
    });

    it('treats an unparseable/missing header as null sendAt and sorts it last', async () => {
        const { gmail } = makeMockGmail({
            labels: [{ id: 'lbl_1', name: SCHEDULED_LABEL_NAME, type: 'user' }],
            drafts: [
                { id: 'draft_bad', message: { id: 'msg_bad' } },
                { id: 'draft_good', message: { id: 'msg_good' } },
            ],
            messages: {
                msg_bad: { id: 'msg_bad', labelIds: ['lbl_1'], headers: { Subject: 'Bad' } },
                msg_good: { id: 'msg_good', labelIds: ['lbl_1'], headers: { Subject: 'Good', [SCHEDULED_SEND_HEADER]: '2026-09-01T00:00:00.000Z' } },
            },
        });
        const result = await fetchScheduledDrafts(gmail);
        expect(result.map(r => r.draftId)).toEqual(['draft_good', 'draft_bad']);
        expect(result[1].sendAt).toBeNull();
    });
});

describe('sendDueScheduledEmails', () => {
    it('sends only drafts whose sendAt has passed, leaves others pending', async () => {
        const past = new Date(Date.now() - 60_000).toISOString();
        const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const { gmail, state } = makeMockGmail({
            labels: [{ id: 'lbl_1', name: SCHEDULED_LABEL_NAME, type: 'user' }],
            drafts: [
                { id: 'draft_due', message: { id: 'msg_due' } },
                { id: 'draft_future', message: { id: 'msg_future' } },
            ],
            messages: {
                msg_due: { id: 'msg_due', labelIds: ['lbl_1'], headers: { Subject: 'Due', To: 'a@example.com', [SCHEDULED_SEND_HEADER]: past } },
                msg_future: { id: 'msg_future', labelIds: ['lbl_1'], headers: { Subject: 'Future', To: 'b@example.com', [SCHEDULED_SEND_HEADER]: future } },
            },
        });

        const result = await sendDueScheduledEmails(gmail);

        expect(result.sent).toHaveLength(1);
        expect(result.sent[0].draftId).toBe('draft_due');
        expect(result.stillPending).toHaveLength(1);
        expect(result.stillPending[0].draftId).toBe('draft_future');
        expect(result.errors).toHaveLength(0);
        expect(state.sendCalls).toEqual(['draft_due']);
        // The sent draft is gone from the mock drafts store (drafts.send consumes it).
        expect(state.drafts.some(d => d.id === 'draft_due')).toBe(false);
    });

    it('is a no-op with empty results when nothing is scheduled', async () => {
        const { gmail } = makeMockGmail({});
        const result = await sendDueScheduledEmails(gmail);
        expect(result).toEqual({ sent: [], stillPending: [], errors: [] });
    });

    it('collects per-item errors without aborting the sweep', async () => {
        const past = new Date(Date.now() - 60_000).toISOString();
        const { gmail } = makeMockGmail({
            labels: [{ id: 'lbl_1', name: SCHEDULED_LABEL_NAME, type: 'user' }],
            drafts: [{ id: 'draft_due', message: { id: 'msg_due' } }],
            messages: {
                msg_due: { id: 'msg_due', labelIds: ['lbl_1'], headers: { Subject: 'Due', To: 'a@example.com', [SCHEDULED_SEND_HEADER]: past } },
            },
        });
        gmail.users.drafts.send = vi.fn(async () => { throw new Error('boom'); });

        const result = await sendDueScheduledEmails(gmail);
        expect(result.sent).toHaveLength(0);
        expect(result.errors).toEqual([{ draftId: 'draft_due', error: 'boom' }]);
    });
});

describe('cancelScheduledEmail', () => {
    it('by default removes the Scheduled label instead of deleting the draft', async () => {
        const { gmail, state } = makeMockGmail({
            labels: [{ id: 'lbl_1', name: SCHEDULED_LABEL_NAME, type: 'user' }],
            drafts: [{ id: 'draft_1', message: { id: 'msg_1' } }],
            messages: { msg_1: { id: 'msg_1', labelIds: ['lbl_1'], headers: {} } },
        });

        const result = await cancelScheduledEmail(gmail, { draftId: 'draft_1' });

        expect(result.action).toBe('unscheduled');
        expect(state.drafts.some(d => d.id === 'draft_1')).toBe(true); // draft still exists
        expect(state.messages.msg_1.labelIds).not.toContain('lbl_1');
    });

    it('permanently deletes the draft when permanentlyDelete is set', async () => {
        const { gmail, state } = makeMockGmail({
            labels: [{ id: 'lbl_1', name: SCHEDULED_LABEL_NAME, type: 'user' }],
            drafts: [{ id: 'draft_1', message: { id: 'msg_1' } }],
            messages: { msg_1: { id: 'msg_1', labelIds: ['lbl_1'], headers: {} } },
        });

        const result = await cancelScheduledEmail(gmail, { draftId: 'draft_1', permanentlyDelete: true });

        expect(result.action).toBe('deleted');
        expect(state.drafts.some(d => d.id === 'draft_1')).toBe(false);
    });

    it('resolves messageId when only draftId is given', async () => {
        const { gmail } = makeMockGmail({
            labels: [{ id: 'lbl_1', name: SCHEDULED_LABEL_NAME, type: 'user' }],
            drafts: [{ id: 'draft_1', message: { id: 'msg_1' } }],
            messages: { msg_1: { id: 'msg_1', labelIds: ['lbl_1'], headers: {} } },
        });
        const result = await cancelScheduledEmail(gmail, { messageId: 'msg_1' });
        expect(result.draftId).toBe('draft_1');
    });

    it('throws when no matching draft is found', async () => {
        const { gmail } = makeMockGmail({});
        await expect(cancelScheduledEmail(gmail, { draftId: 'nope' })).rejects.toThrow();
    });
});
