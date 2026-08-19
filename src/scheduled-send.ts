/**
 * Scheduled Send for Gmail MCP Server
 *
 * The Gmail API has no native "send later" endpoint (users.messages.send and
 * users.drafts.send both send immediately; the schedule-send button in the Gmail
 * web UI is a client-side feature with no API surface). This module implements
 * scheduling entirely on top of existing Gmail primitives, with no new
 * infrastructure or persistent store outside Gmail itself:
 *
 *   1. schedule_email creates a normal draft (reusing the existing draft-creation
 *      path in index.ts, including threading/quoting/attachments), stamps it with
 *      an `X-Scheduled-Send-At` header carrying the target time, and applies a
 *      "Scheduled" user label to the draft's underlying message.
 *   2. A Cloud Scheduler job periodically calls the send_due_scheduled_emails tool
 *      (a normal MCP tools/call request against the existing /mcp endpoint - no
 *      separate HTTP route is needed). It lists drafts under the "Scheduled"
 *      label, and for each whose X-Scheduled-Send-At has passed, calls
 *      drafts.send, which sends the exact composed message and removes it from
 *      Drafts.
 *   3. list_scheduled_emails and cancel_scheduled_email read/unwind that same
 *      state (the label + header), so everything a person needs to see or cancel
 *      lives in Gmail, not in a side database.
 */

import { withTimeout, DEFAULT_TIMEOUT_MS } from "./timeout.js";
import { getOrCreateLabel, findLabelByName } from "./label-manager.js";

export const SCHEDULED_LABEL_NAME = "Scheduled";
export const SCHEDULED_SEND_HEADER = "X-Scheduled-Send-At";

export interface ScheduledEmailSummary {
    draftId: string;
    messageId: string;
    to: string;
    subject: string;
    sendAt: string | null; // ISO 8601, or null if the header is missing/unparseable
    snippet: string;
}

/** Extract a single header value (case-insensitive) from a Gmail message payload. */
function getHeaderValue(headers: Array<{ name?: string | null; value?: string | null }> | undefined, name: string): string {
    if (!headers) return "";
    const lower = name.toLowerCase();
    return headers.find(h => (h.name || "").toLowerCase() === lower)?.value || "";
}

/**
 * Fetches every draft under the "Scheduled" label along with its parsed send time.
 * Read-only; used by both list_scheduled_emails and send_due_scheduled_emails.
 */
export async function fetchScheduledDrafts(gmail: any, maxResults = 100): Promise<ScheduledEmailSummary[]> {
    const label = await findLabelByName(gmail, SCHEDULED_LABEL_NAME);
    if (!label) return [];

    const results: ScheduledEmailSummary[] = [];
    let pageToken: string | undefined;
    do {
        const page: any = await withTimeout(gmail.users.drafts.list({
            userId: "me",
            q: `label:${SCHEDULED_LABEL_NAME}`,
            maxResults: Math.min(maxResults - results.length, 100),
            pageToken,
        }), DEFAULT_TIMEOUT_MS, "drafts.list scheduled");

        const drafts = page.data.drafts || [];
        for (const draft of drafts) {
            if (!draft.message?.id) continue;
            const detail = await withTimeout(gmail.users.messages.get({
                userId: "me",
                id: draft.message.id,
                format: "metadata",
                metadataHeaders: ["Subject", "To", SCHEDULED_SEND_HEADER],
            }), DEFAULT_TIMEOUT_MS, `messages.get scheduled ${draft.message.id}`);

            const headers = detail.data.payload?.headers || [];
            const rawSendAt = getHeaderValue(headers, SCHEDULED_SEND_HEADER);
            const parsed = rawSendAt ? new Date(rawSendAt) : null;
            results.push({
                draftId: draft.id,
                messageId: draft.message.id,
                to: getHeaderValue(headers, "To"),
                subject: getHeaderValue(headers, "Subject"),
                sendAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
                snippet: detail.data.snippet || "",
            });
            if (results.length >= maxResults) break;
        }
        pageToken = results.length >= maxResults ? undefined : (page.data.nextPageToken || undefined);
    } while (pageToken);

    // Emails with no parseable sendAt sort last; otherwise soonest first.
    results.sort((a, b) => {
        if (a.sendAt && b.sendAt) return a.sendAt.localeCompare(b.sendAt);
        if (a.sendAt) return -1;
        if (b.sendAt) return 1;
        return 0;
    });
    return results;
}

/**
 * Applies the "Scheduled" label (creating it if needed) to a draft's underlying message.
 * Called right after the draft is created by schedule_email.
 */
export async function markDraftScheduled(gmail: any, draftMessageId: string): Promise<{ id: string; name: string }> {
    const label = await getOrCreateLabel(gmail, SCHEDULED_LABEL_NAME, {
        messageListVisibility: "show",
        labelListVisibility: "labelShow",
    });
    await withTimeout(gmail.users.messages.modify({
        userId: "me",
        id: draftMessageId,
        requestBody: { addLabelIds: [label.id] },
    }), DEFAULT_TIMEOUT_MS, "messages.modify add Scheduled label");
    return { id: label.id, name: label.name };
}

/**
 * Cancels a scheduled send. By default this only removes the "Scheduled" label,
 * so the draft reverts to a normal editable draft the sweep will never touch again
 * (Jordan's content is not lost). Pass permanentlyDelete to remove the draft outright.
 */
export async function cancelScheduledEmail(
    gmail: any,
    opts: { draftId?: string; messageId?: string; permanentlyDelete?: boolean }
): Promise<{ draftId: string; action: "unscheduled" | "deleted" }> {
    let draftId = opts.draftId;
    let messageId = opts.messageId;

    if (!draftId || !messageId) {
        // Resolve whichever ID is missing via drafts.list, same approach as delete_draft.
        let pageToken: string | undefined;
        do {
            const page: any = await withTimeout(gmail.users.drafts.list({
                userId: "me",
                maxResults: 100,
                pageToken,
            }), DEFAULT_TIMEOUT_MS, "drafts.list resolve");
            const match = (page.data.drafts || []).find((d: any) =>
                (draftId && d.id === draftId) || (messageId && d.message?.id === messageId)
            );
            if (match) {
                draftId = match.id;
                messageId = match.message?.id;
                break;
            }
            pageToken = page.data.nextPageToken || undefined;
        } while (pageToken);
    }

    if (!draftId) {
        throw new Error("No matching scheduled draft found for the given draftId/messageId");
    }

    if (opts.permanentlyDelete) {
        await withTimeout(gmail.users.drafts.delete({ userId: "me", id: draftId }), DEFAULT_TIMEOUT_MS, "drafts.delete scheduled");
        return { draftId, action: "deleted" };
    }

    if (!messageId) {
        throw new Error(`Could not resolve the underlying message for draft ${draftId}`);
    }
    const label = await findLabelByName(gmail, SCHEDULED_LABEL_NAME);
    if (label) {
        await withTimeout(gmail.users.messages.modify({
            userId: "me",
            id: messageId,
            requestBody: { removeLabelIds: [label.id] },
        }), DEFAULT_TIMEOUT_MS, "messages.modify remove Scheduled label");
    }
    return { draftId, action: "unscheduled" };
}

/**
 * The sweep: sends every scheduled draft whose time has passed. Intended to be invoked
 * by a Cloud Scheduler job hitting the MCP endpoint on a fixed interval (e.g. every 5
 * minutes), not called directly by the agent in normal email processing.
 */
export async function sendDueScheduledEmails(gmail: any): Promise<{
    sent: Array<{ draftId: string; messageId: string; to: string; subject: string; sendAt: string }>;
    stillPending: Array<{ draftId: string; to: string; subject: string; sendAt: string | null }>;
    errors: Array<{ draftId: string; error: string }>;
}> {
    const scheduled = await fetchScheduledDrafts(gmail, 200);
    const now = Date.now();

    const sent: Array<{ draftId: string; messageId: string; to: string; subject: string; sendAt: string }> = [];
    const stillPending: Array<{ draftId: string; to: string; subject: string; sendAt: string | null }> = [];
    const errors: Array<{ draftId: string; error: string }> = [];

    for (const item of scheduled) {
        // No parseable sendAt: leave it alone rather than guessing. list_scheduled_emails
        // will surface it so a person can investigate.
        if (!item.sendAt) {
            stillPending.push({ draftId: item.draftId, to: item.to, subject: item.subject, sendAt: null });
            continue;
        }
        if (new Date(item.sendAt).getTime() > now) {
            stillPending.push({ draftId: item.draftId, to: item.to, subject: item.subject, sendAt: item.sendAt });
            continue;
        }
        try {
            const result = await withTimeout(gmail.users.drafts.send({
                userId: "me",
                requestBody: { id: item.draftId },
            }), DEFAULT_TIMEOUT_MS, `drafts.send ${item.draftId}`);
            sent.push({
                draftId: item.draftId,
                messageId: result.data.id || item.messageId,
                to: item.to,
                subject: item.subject,
                sendAt: item.sendAt,
            });
        } catch (error: any) {
            errors.push({ draftId: item.draftId, error: error.message || String(error) });
        }
    }

    return { sent, stillPending, errors };
}
