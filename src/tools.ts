import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Schema definitions

// An attachment can be a server file path (legacy) or an inline object carrying bytes directly.
export const AttachmentInputSchema = z.union([
  z.string(),
  z.object({
    filename: z.string(),
    mimeType: z.string().optional(),
    contentBase64: z.string(),
  }),
]);

const ATTACHMENTS_DESCRIPTION = "Attachments: each item is either a file path on the server, or an object {filename, mimeType?, contentBase64} carrying the file bytes inline (standard base64). Total inline size limit 20 MB.";

export const SendEmailSchema = z.object({
  to: z.array(z.string()).describe("List of recipient email addresses"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body content (used for text/plain or when htmlBody not provided)"),
  from: z.string().optional().describe("Sender email address (must be a configured send-as alias in Gmail settings). Defaults to account's default send-as address if not specified."),
  htmlBody: z.string().optional().describe("HTML version of the email body"),
  mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
  cc: z.array(z.string()).optional().describe("List of CC recipients"),
  bcc: z.array(z.string()).optional().describe("List of BCC recipients"),
  threadId: z.string().optional().describe("Thread ID to reply to"),
  inReplyTo: z.string().optional().describe("Message ID being replied to"),
  attachments: z.array(AttachmentInputSchema).optional().describe(ATTACHMENTS_DESCRIPTION),
  skipQuote: z.boolean().optional().default(false).describe("Skip auto-quoting the original message when replying to a thread"),
});

export const DraftEmailSchema = SendEmailSchema.extend({
  replaceThreadDrafts: z.boolean().optional().default(false).describe("If true and threadId is set, creates the new draft, then deletes the authenticated user's OTHER existing drafts on that thread (via drafts.list + drafts.delete), so at most one draft remains on the thread. This also deletes a human's own in-progress draft on the same thread, not just prior agent drafts, so it is opt-in and defaults to false. No-op if threadId is not provided (there is no thread to scope the replacement to). The response lists any drafts that were replaced."),
});

export const ReadEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to retrieve"),
});

export const SearchEmailsSchema = z.object({
  query: z.string().describe("Gmail search query (e.g., 'from:example@gmail.com')"),
  maxResults: z.number().optional().describe("Maximum number of results to return"),
});

export const ModifyEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to modify"),
  labelIds: z.array(z.string()).optional().describe("List of label IDs to apply"),
  addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to the message"),
  removeLabelIds: z.array(z.string()).optional().describe("List of label IDs to remove from the message"),
});

export const DeleteEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to delete"),
});

export const ScheduleEmailSchema = SendEmailSchema.extend({
  sendAt: z.string().describe("ISO 8601 date-time for when to send this email, e.g. '2026-08-20T14:00:00-04:00'. Include a timezone offset or trailing Z; a bare local time is ambiguous. Must be in the future."),
}).refine(d => {
  const t = Date.parse(d.sendAt);
  return !Number.isNaN(t) && t > Date.now();
}, { message: "sendAt must be a valid ISO 8601 date-time in the future", path: ["sendAt"] });

export const ListScheduledEmailsSchema = z.object({
  maxResults: z.number().optional().default(50).describe("Maximum number of scheduled emails to return (default 50)"),
});

export const CancelScheduledEmailSchema = z.object({
  draftId: z.string().optional().describe("Draft ID of the scheduled email to cancel (the r... value returned by schedule_email, or from list_scheduled_emails)"),
  messageId: z.string().optional().describe("Message ID of the scheduled draft (alternative to draftId)"),
  permanentlyDelete: z.boolean().optional().default(false).describe("If true, permanently deletes the draft. If false (default), only removes the Scheduled label so the draft reverts to a normal editable draft and will not be auto-sent."),
}).refine(d => d.draftId || d.messageId, { message: "Provide draftId or messageId" });

export const SendDueScheduledEmailsSchema = z.object({}).describe(
  "Sends every scheduled email whose sendAt time has passed. Meant to be called on a timer (e.g. by a Cloud Scheduler job hitting this MCP endpoint every few minutes), not as part of normal email processing."
);

export const DeleteDraftSchema = z.object({
  draftId: z.string().optional().describe("Draft ID (the r... value returned by draft_email). Either draftId or messageId is required."),
  messageId: z.string().optional().describe("Message ID of the draft (as returned by search_emails with in:drafts). Resolved to the draft ID via drafts.list."),
}).refine(d => d.draftId || d.messageId, { message: "Provide draftId or messageId" });

export const ListEmailLabelsSchema = z.object({}).describe("Retrieves all available Gmail labels");

export const CreateLabelSchema = z.object({
  name: z.string().describe("Name for the new label"),
  messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Creates a new Gmail label");

export const UpdateLabelSchema = z.object({
  id: z.string().describe("ID of the label to update"),
  name: z.string().optional().describe("New name for the label"),
  messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Updates an existing Gmail label");

export const DeleteLabelSchema = z.object({
  id: z.string().describe("ID of the label to delete"),
}).describe("Deletes a Gmail label");

export const GetOrCreateLabelSchema = z.object({
  name: z.string().describe("Name of the label to get or create"),
  messageListVisibility: z.enum(['show', 'hide']).optional().describe("Whether to show or hide the label in the message list"),
  labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe("Visibility of the label in the label list"),
}).describe("Gets an existing label by name or creates it if it doesn't exist");

export const BatchModifyEmailsSchema = z.object({
  messageIds: z.array(z.string()).describe("List of message IDs to modify"),
  addLabelIds: z.array(z.string()).optional().describe("List of label IDs to add to all messages"),
  removeLabelIds: z.array(z.string()).optional().describe("List of label IDs to remove from all messages"),
  batchSize: z.number().optional().default(50).describe("Number of messages to process in each batch (default: 50)"),
});

export const BatchDeleteEmailsSchema = z.object({
  messageIds: z.array(z.string()).describe("List of message IDs to delete"),
  batchSize: z.number().optional().default(50).describe("Number of messages to process in each batch (default: 50)"),
});

export const CreateFilterSchema = z.object({
  criteria: z.object({
    from: z.string().optional().describe("Sender email address to match"),
    to: z.string().optional().describe("Recipient email address to match"),
    subject: z.string().optional().describe("Subject text to match"),
    query: z.string().optional().describe("Gmail search query (e.g., 'has:attachment')"),
    negatedQuery: z.string().optional().describe("Text that must NOT be present"),
    hasAttachment: z.boolean().optional().describe("Whether to match emails with attachments"),
    excludeChats: z.boolean().optional().describe("Whether to exclude chat messages"),
    size: z.number().optional().describe("Email size in bytes"),
    sizeComparison: z.enum(['unspecified', 'smaller', 'larger']).optional().describe("Size comparison operator")
  }).describe("Criteria for matching emails"),
  action: z.object({
    addLabelIds: z.array(z.string()).optional().describe("Label IDs to add to matching emails"),
    removeLabelIds: z.array(z.string()).optional().describe("Label IDs to remove from matching emails"),
    forward: z.string().optional().describe("Email address to forward matching emails to")
  }).describe("Actions to perform on matching emails")
}).describe("Creates a new Gmail filter");

export const ListFiltersSchema = z.object({}).describe("Retrieves all Gmail filters");

export const GetFilterSchema = z.object({
  filterId: z.string().describe("ID of the filter to retrieve")
}).describe("Gets details of a specific Gmail filter");

export const DeleteFilterSchema = z.object({
  filterId: z.string().describe("ID of the filter to delete")
}).describe("Deletes a Gmail filter");

export const CreateFilterFromTemplateSchema = z.object({
  template: z.enum(['fromSender', 'withSubject', 'withAttachments', 'largeEmails', 'containingText', 'mailingList']).describe("Pre-defined filter template to use"),
  parameters: z.object({
    senderEmail: z.string().optional().describe("Sender email (for fromSender template)"),
    subjectText: z.string().optional().describe("Subject text (for withSubject template)"),
    searchText: z.string().optional().describe("Text to search for (for containingText template)"),
    listIdentifier: z.string().optional().describe("Mailing list identifier (for mailingList template)"),
    sizeInBytes: z.number().optional().describe("Size threshold in bytes (for largeEmails template)"),
    labelIds: z.array(z.string()).optional().describe("Label IDs to apply"),
    archive: z.boolean().optional().describe("Whether to archive (skip inbox)"),
    markAsRead: z.boolean().optional().describe("Whether to mark as read"),
    markImportant: z.boolean().optional().describe("Whether to mark as important")
  }).describe("Template-specific parameters")
}).describe("Creates a filter using a pre-defined template");

export const DownloadAttachmentSchema = z.object({
  messageId: z.string().describe("ID of the email message containing the attachment"),
  attachmentId: z.string().describe("ID of the attachment to download"),
  filename: z.string().optional().describe("Original filename hint (used to detect the file type when Gmail's part metadata cannot be matched; attachment IDs are not stable between calls). In mode='file' it is also the name saved to disk."),
  mimeType: z.string().optional().describe("MIME type hint for the attachment (e.g. from read_email's attachment list). Used when the part metadata cannot be matched."),
  savePath: z.string().optional().describe("Directory path to save the attachment (defaults to current directory). Only used by mode='file'."),
  mode: z.enum(['auto', 'text', 'base64', 'file']).optional().default('auto').describe(
    "auto (default): returns extracted text inline for PDF/DOCX/XLSX/XLS/CSV/TXT/MD/JSON/HTML attachments, or base64 inline for everything else. " +
    "text: force text extraction, erroring if the type isn't supported. " +
    "base64: always return {filename, mimeType, size, contentBase64} inline (default cap 10 MB; override with maxBytes). " +
    "file: legacy behavior, saves the attachment to disk on the server."
  ),
  maxBytes: z.number().optional().describe("Maximum attachment size (bytes) to return inline for modes auto/text/base64. Defaults to 10 MB. Attachments over this size return an error suggesting mode='file' or a larger maxBytes."),
});

export const DownloadEmailSchema = z.object({
  messageId: z.string().describe("ID of the email message to download"),
  savePath: z.string().describe("Directory path to save the email file"),
  format: z.enum(['json', 'eml', 'txt', 'html']).optional().default('json')
    .describe("Output format: json (structured data), eml (raw RFC822), txt (plain text), html (formatted HTML)"),
});

// Thread-level schemas
export const GetThreadSchema = z.object({
  threadId: z.string().describe("ID of the email thread to retrieve"),
  format: z.enum(['full', 'metadata', 'minimal']).optional().default('full').describe("Format of the email messages returned (default: full)"),
});

export const ListInboxThreadsSchema = z.object({
  query: z.string().optional().default('in:inbox').describe("Gmail search query (default: 'in:inbox')"),
  maxResults: z.number().optional().default(50).describe("Maximum number of threads to return (default: 50)"),
});

export const GetInboxWithThreadsSchema = z.object({
  query: z.string().optional().default('in:inbox').describe("Gmail search query (default: 'in:inbox')"),
  maxResults: z.number().optional().default(50).describe("Maximum number of threads to return (default: 50)"),
  expandThreads: z.boolean().optional().default(true).describe("Whether to fetch full thread content for each thread (default: true)"),
});

// Reply All schema - fetches original email and builds recipient list automatically
export const ReplyAllSchema = z.object({
  messageId: z.string().describe("ID of the email message to reply to"),
  body: z.string().describe("Reply body content (used for text/plain or when htmlBody not provided)"),
  htmlBody: z.string().optional().describe("HTML version of the reply body"),
  mimeType: z.enum(['text/plain', 'text/html', 'multipart/alternative']).optional().default('text/plain').describe("Email content type"),
  attachments: z.array(AttachmentInputSchema).optional().describe(ATTACHMENTS_DESCRIPTION),
});

// People API schemas (contact and directory lookup)
export const SearchContactsSchema = z.object({
  query: z.string().describe("Name or email prefix to look up, e.g. 'Hadeer' or 'elsamalotyh@parkschool.org'. People API matches prefix phrases, so partial names work."),
  maxResults: z.number().optional().default(10).describe("Maximum number of people to return after de-duplication (default 10)"),
});

export const GetContactPhotoSchema = z.object({
  email: z.string().describe("Email address of the person whose profile photo you want"),
  size: z.number().optional().default(512).describe("Requested photo width/height in pixels (default 512)"),
  mode: z.enum(['url', 'base64']).optional().default('url').describe("'url' returns the sized photo URL only; 'base64' also fetches the bytes server-side and returns them inline"),
});

// Tool definition type
export interface ToolAnnotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType<any>;
  scopes: string[]; // Any of these scopes grants access
  annotations: ToolAnnotations;
}

// Tool registry with scope requirements
export const toolDefinitions: ToolDefinition[] = [
  // Read-only email operations
  {
    name: "read_email",
    description: "Retrieves the content of a specific email",
    schema: ReadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Read Email", readOnlyHint: true },
  },
  {
    name: "search_emails",
    description: "Searches for emails using Gmail search syntax",
    schema: SearchEmailsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Search Emails", readOnlyHint: true },
  },
  {
    name: "download_attachment",
    description: "Retrieves an email attachment. By default (mode='auto') returns extracted text inline for PDF, DOCX, XLSX/XLS/CSV, TXT/MD/JSON, and HTML attachments, or base64-encoded bytes inline for other types (e.g. images) — no server filesystem access needed. Use mode='text' to force extraction (errors on unsupported types), mode='base64' to always get raw bytes inline, or mode='file' for the legacy behavior of saving to disk on the server.",
    schema: DownloadAttachmentSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Attachment", readOnlyHint: true },
  },

  // Thread-level operations
  {
    name: "get_thread",
    description: "Retrieves all messages in an email thread in one call. Returns messages ordered chronologically (oldest first) with full content, headers, labels, and attachment metadata.",
    schema: GetThreadSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Thread", readOnlyHint: true },
  },
  {
    name: "list_inbox_threads",
    description: "Lists email threads matching a query (default: inbox). Returns thread-level view with snippet, message count, and latest message metadata.",
    schema: ListInboxThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "List Inbox Threads", readOnlyHint: true },
  },
  {
    name: "get_inbox_with_threads",
    description: "Convenience tool that lists threads and optionally expands each with full message content. One call returns the full inbox with complete thread bodies.",
    schema: GetInboxWithThreadsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Get Inbox with Threads", readOnlyHint: true },
  },
  {
    name: "download_email",
    description: "Downloads an email to a file in various formats (json, eml, txt, html). Returns metadata only - useful for saving emails without consuming context.",
    schema: DownloadEmailSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "Download Email", readOnlyHint: true },
  },

  // Email write operations
  {
    name: "send_email",
    description: "Sends a new email",
    schema: SendEmailSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Send Email", destructiveHint: false },
  },
  {
    name: "draft_email",
    description: "Draft a new email. Optional replaceThreadDrafts (default false): when true and threadId is set, creates the new draft and then deletes this account's other existing drafts on that thread, so only one draft remains per thread. This deletes ANY draft on the thread, including one a human is mid-way through writing, which is why it is opt-in.",
    schema: DraftEmailSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Draft Email", destructiveHint: false },
  },
  {
    name: "schedule_email",
    description: "Composes an email (same fields as draft_email, plus sendAt) and schedules it to send automatically at that time. Gmail's API has no native schedule-send, so this creates a draft tagged with a 'Scheduled' label and an X-Scheduled-Send-At header; a periodic sweep (send_due_scheduled_emails) sends it once due. The draft is visible and editable in Gmail like any other draft until it sends. Use list_scheduled_emails to see pending sends and cancel_scheduled_email to stop one.",
    schema: ScheduleEmailSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Schedule Email", destructiveHint: false },
  },
  {
    name: "list_scheduled_emails",
    description: "Lists emails currently scheduled to send later (drafts under the 'Scheduled' label), with their target send time, recipient, and subject.",
    schema: ListScheduledEmailsSchema,
    scopes: ["gmail.readonly", "gmail.modify"],
    annotations: { title: "List Scheduled Emails", readOnlyHint: true },
  },
  {
    name: "cancel_scheduled_email",
    description: "Cancels a scheduled send. By default just removes the 'Scheduled' label, leaving a normal editable draft behind; pass permanentlyDelete to remove the draft entirely.",
    schema: CancelScheduledEmailSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Cancel Scheduled Email", destructiveHint: true },
  },
  {
    name: "send_due_scheduled_emails",
    description: "Sends every scheduled email whose sendAt time has passed. This is the trigger endpoint for scheduled sends: intended to be called on a timer (e.g. a Cloud Scheduler job) rather than during normal email processing.",
    schema: SendDueScheduledEmailsSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Send Due Scheduled Emails", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "modify_email",
    description: "Modifies email labels (move to different folders)",
    schema: ModifyEmailSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Modify Email", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_email",
    description: "Permanently deletes an email. Permanent deletion requires the full https://mail.google.com/ scope; if that scope is not held, the message is moved to Trash instead and the response says so.",
    schema: DeleteEmailSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Delete Email", destructiveHint: true },
  },
  {
    name: "delete_draft",
    description: "Permanently deletes a Gmail draft (removes it from the Drafts folder). Accepts the draft ID returned by draft_email or the draft's message ID from an in:drafts search. Uses drafts.delete, which is covered by the gmail.modify scope.",
    schema: DeleteDraftSchema,
    scopes: ["gmail.modify", "gmail.compose"],
    annotations: { title: "Delete Draft", destructiveHint: true },
  },
  {
    name: "batch_modify_emails",
    description: "Modifies labels for multiple emails in batches",
    schema: BatchModifyEmailsSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Batch Modify Emails", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "batch_delete_emails",
    description: "Permanently deletes multiple emails in batches",
    schema: BatchDeleteEmailsSchema,
    scopes: ["gmail.modify"],
    annotations: { title: "Batch Delete Emails", destructiveHint: true },
  },

  // Label operations
  {
    name: "list_email_labels",
    description: "Retrieves all available Gmail labels",
    schema: ListEmailLabelsSchema,
    scopes: ["gmail.readonly", "gmail.modify", "gmail.labels"],
    annotations: { title: "List Email Labels", readOnlyHint: true },
  },
  {
    name: "create_label",
    description: "Creates a new Gmail label",
    schema: CreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Create Label", destructiveHint: false },
  },
  {
    name: "update_label",
    description: "Updates an existing Gmail label",
    schema: UpdateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Update Label", destructiveHint: true, idempotentHint: true },
  },
  {
    name: "delete_label",
    description: "Deletes a Gmail label",
    schema: DeleteLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Delete Label", destructiveHint: true },
  },
  {
    name: "get_or_create_label",
    description: "Gets an existing label by name or creates it if it doesn't exist",
    schema: GetOrCreateLabelSchema,
    scopes: ["gmail.modify", "gmail.labels"],
    annotations: { title: "Get or Create Label", destructiveHint: false, idempotentHint: true },
  },

  // Filter operations (require settings scope)
  {
    name: "list_filters",
    description: "Retrieves all Gmail filters",
    schema: ListFiltersSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "List Filters", readOnlyHint: true },
  },
  {
    name: "get_filter",
    description: "Gets details of a specific Gmail filter",
    schema: GetFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Get Filter", readOnlyHint: true },
  },
  {
    name: "create_filter",
    description: "Creates a new Gmail filter with custom criteria and actions",
    schema: CreateFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter", destructiveHint: false },
  },
  {
    name: "delete_filter",
    description: "Deletes a Gmail filter",
    schema: DeleteFilterSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Delete Filter", destructiveHint: true },
  },
  {
    name: "create_filter_from_template",
    description: "Creates a filter using a pre-defined template for common scenarios",
    schema: CreateFilterFromTemplateSchema,
    scopes: ["gmail.settings.basic"],
    annotations: { title: "Create Filter from Template", destructiveHint: false },
  },

  // Reply-all operation
  {
    name: "reply_all",
    description: "Replies to all recipients of an email. Automatically fetches the original email to build the recipient list (To, CC) and sets proper threading headers.",
    schema: ReplyAllSchema,
    scopes: ["gmail.modify", "gmail.compose", "gmail.send"],
    annotations: { title: "Reply All", destructiveHint: false },
  },

  // People operations (Workspace directory, saved contacts, other contacts)
  {
    name: "search_contacts",
    description: "Looks up people by name or email across three sources: the Google Workspace domain directory (colleagues), the user's saved contacts, and 'other contacts' (addresses the user has emailed but never saved). Results are merged and de-duplicated by email, each carrying the person's display name, all known emails, their profile photo URL, and which source matched. Any source that is unavailable (missing scope, People API not enabled) is skipped and noted in the 'warnings' array rather than failing the call.",
    schema: SearchContactsSchema,
    scopes: ["directory.readonly", "contacts.readonly", "contacts.other.readonly"],
    annotations: { title: "Search Contacts", readOnlyHint: true },
  },
  {
    name: "get_contact_photo",
    description: "Fetches a person's Google account profile photo by email address. Returns the photo URL sized to the requested pixel dimension; with mode='base64' it also fetches the image bytes server-side and returns them inline. Errors clearly when the person cannot be found or has only Google's default placeholder avatar rather than a real photo.",
    schema: GetContactPhotoSchema,
    scopes: ["directory.readonly", "contacts.readonly", "contacts.other.readonly"],
    annotations: { title: "Get Contact Photo", readOnlyHint: true },
  },
];

// Convert tool definitions to MCP tool format
export function toMcpTools(tools: ToolDefinition[]) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.schema),
    annotations: tool.annotations,
  }));
}

// Get a tool definition by name
export function getToolByName(name: string): ToolDefinition | undefined {
  return toolDefinitions.find(t => t.name === name);
}
