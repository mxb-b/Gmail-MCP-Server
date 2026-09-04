# Gmail AutoAuth MCP Server (Actively Maintained Fork)

[![CI](https://github.com/ArtyMcLabin/Gmail-MCP-Server/actions/workflows/ci.yml/badge.svg)](https://github.com/ArtyMcLabin/Gmail-MCP-Server/actions/workflows/ci.yml)

> **This is an actively maintained fork of [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server).**
>
> The original repository has been unmaintained since August 2025 — 7+ months with zero maintainer activity and 72+ unmerged pull requests. I use this MCP server daily as part of my Claude Code workflow and depend on it working correctly, so I picked it up.
>
> **Pull requests are welcome.** If you've been sitting on fixes or features with nowhere to submit them, this is the place.

### What this fork adds

- **Fixed reply threading** — auto-resolves `In-Reply-To` and `References` headers so email replies land in the correct thread instead of creating orphaned messages ([upstream PR #91](https://github.com/GongRzhe/Gmail-MCP-Server/pull/91), still pending)
- **Send-as alias support** — optional `from` parameter for multi-identity email management (send from any configured Gmail alias)
- **Reply-all tool** — `reply_all` automatically fetches the original email, builds To/CC recipient lists (excluding yourself), and sets proper threading headers ([PR #3](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/3) by [@MaxGhenis](https://github.com/MaxGhenis))
- **Fixed `list_filters`** — was returning empty array due to wrong response property name ([PR #4](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/4) by [@nicholas-anthony-ai](https://github.com/nicholas-anthony-ai))
- **Custom OAuth2 scoping** — `--scopes` flag to request only the permissions you need, with automatic tool filtering ([PR #6](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/6) by [@tansanDOTeth](https://github.com/tansanDOTeth))
- **CI/CD hardening** — fixed shell injection vector in GitHub Actions workflow, added least-privilege permissions scope ([PR #9](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/9) by [@JF10R](https://github.com/JF10R))
- **Security hardening** — fixed path traversal in attachment download, restricted OAuth credential file permissions ([PR #10](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/10) by [@JF10R](https://github.com/JF10R))
- **Dependency security** — upgraded MCP SDK to v1.27.1 (3 CVE fixes), upgraded nodemailer (DoS + routing fix), moved dev-only packages out of production deps ([PR #11](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/11) by [@JF10R](https://github.com/JF10R))
- **Thread-level tools** — `get_thread`, `list_inbox_threads`, `get_inbox_with_threads` for efficient thread-based email reading in a single call
- **Tool annotations** — MCP spec annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) on all tools for safer LLM tool execution ([PR #14](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/14) by [@bryankthompson](https://github.com/bryankthompson))
- **Download email tool** — `download_email` saves emails to disk in json/eml/txt/html formats without consuming LLM context ([PR #13](https://github.com/ArtyMcLabin/Gmail-MCP-Server/pull/13) by [@icanhasjonas](https://github.com/icanhasjonas))
- **Inline attachments** — attach and download files without touching the server's filesystem: `send_email`/`draft_email`/`reply_all` accept attachment bytes directly as base64, and `download_attachment` can return extracted text (PDF/DOCX/XLSX/CSV/etc.) or raw base64 inline instead of writing to disk. Essential for servers running on remote infrastructure like Cloud Run. See [Inline attachments](#inline-attachments) below.
- **Scheduled send**: `schedule_email`, `list_scheduled_emails`, and `cancel_scheduled_email` let you queue an email to send at a future time, since the Gmail API itself has no schedule-send endpoint. Built entirely on existing Gmail primitives (a labeled draft plus a custom header), no external database required. See tools 21-24 below.
- **One draft per thread (opt-in)** — `draft_email` accepts an optional `replaceThreadDrafts` flag (default `false`). When set and `threadId` is provided, it deletes every existing draft on that thread for the account before creating the new one, so at most one draft remains per thread. **This is off by default and must be explicitly requested**, because it deletes ALL matching drafts, including a human's own in-progress draft on the same thread, not just drafts this tool created. See [One draft per thread](#one-draft-per-thread-replacethreaddrafts) below.

All features are production-tested in daily use.

[![Star History Chart](https://api.star-history.com/svg?repos=ArtyMcLabin/Gmail-MCP-Server&type=Date)](https://star-history.com/#ArtyMcLabin/Gmail-MCP-Server&Date)

---

A Model Context Protocol (MCP) server for Gmail integration in Claude Desktop with auto authentication support. This server enables AI assistants to manage Gmail through natural language interactions.

![](https://badge.mcpx.dev?type=server 'MCP Server')


## Features

- Send emails with subject, content, **attachments**, and recipients
- **Full attachment support** - send and receive file attachments
- **Download email attachments** to local filesystem
- **Download full emails** to files in json/eml/txt/html formats
- **Thread-level operations** — get full threads, list inbox threads, batch-expand threads
- Support for HTML emails and multipart messages with both HTML and plain text versions
- Full support for international characters in subject lines and email content
- Read email messages by ID with advanced MIME structure handling
- **Enhanced attachment display** showing filenames, types, sizes, and download IDs
- Search emails with various criteria (subject, sender, date range)
- **Comprehensive label management with ability to create, update, delete and list labels**
- List all available Gmail labels (system and user-defined)
- List emails in inbox, sent, or custom labels
- Mark emails as read/unread
- Move emails to different labels/folders
- Delete emails
- **Batch operations for efficiently processing multiple emails at once**
- Full integration with Gmail API
- Simple OAuth2 authentication flow with auto browser launch
- Support for both Desktop and Web application credentials
- Global credential storage for convenience

## Installation & Authentication

### Installing Manually
1. Create a Google Cloud Project and obtain credentials:

   a. Create a Google Cloud Project:
      - Go to [Google Cloud Console](https://console.cloud.google.com/)
      - Create a new project or select an existing one
      - Enable the Gmail API for your project

   b. Create OAuth 2.0 Credentials:
      - Go to "APIs & Services" > "Credentials"
      - Click "Create Credentials" > "OAuth client ID"
      - Choose either "Desktop app" or "Web application" as application type
      - Give it a name and click "Create"
      - For Web application, add `http://localhost:3000/oauth2callback` to the authorized redirect URIs
      - Download the JSON file of your client's OAuth keys
      - Rename the key file to `gcp-oauth.keys.json`

2. Run Authentication:

   You can authenticate in two ways:

   a. Global Authentication (Recommended):
   ```bash
   # First time: Place gcp-oauth.keys.json in your home directory's .gmail-mcp folder
   mkdir -p ~/.gmail-mcp
   mv gcp-oauth.keys.json ~/.gmail-mcp/

   # Run authentication from anywhere
   npx @gongrzhe/server-gmail-autoauth-mcp auth
   ```

   b. Local Authentication:
   ```bash
   # Place gcp-oauth.keys.json in your current directory
   # The file will be automatically copied to global config
   npx @gongrzhe/server-gmail-autoauth-mcp auth
   ```

   The authentication process will:
   - Look for `gcp-oauth.keys.json` in the current directory or `~/.gmail-mcp/`
   - If found in current directory, copy it to `~/.gmail-mcp/`
   - Open your default browser for Google authentication
   - Save credentials as `~/.gmail-mcp/credentials.json`

   > **Note**: 
   > - After successful authentication, credentials are stored globally in `~/.gmail-mcp/` and can be used from any directory
   > - Both Desktop app and Web application credentials are supported
   > - For Web application credentials, make sure to add `http://localhost:3000/oauth2callback` to your authorized redirect URIs

3. Configure in Claude Desktop:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": [
        "@gongrzhe/server-gmail-autoauth-mcp"
      ]
    }
  }
}
```

### Docker Support

If you prefer using Docker:

1. Authentication:
```bash
docker run -i --rm \
  --mount type=bind,source=/path/to/gcp-oauth.keys.json,target=/gcp-oauth.keys.json \
  -v mcp-gmail:/gmail-server \
  -e GMAIL_OAUTH_PATH=/gcp-oauth.keys.json \
  -e "GMAIL_CREDENTIALS_PATH=/gmail-server/credentials.json" \
  -p 3000:3000 \
  mcp/gmail auth
```

2. Usage:
```json
{
  "mcpServers": {
    "gmail": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "mcp-gmail:/gmail-server",
        "-e",
        "GMAIL_CREDENTIALS_PATH=/gmail-server/credentials.json",
        "mcp/gmail"
      ]
    }
  }
}
```

### Cloud Server Authentication

For cloud server environments (like n8n), you can specify a custom callback URL during authentication:

```bash
npx @gongrzhe/server-gmail-autoauth-mcp auth https://gmail.gongrzhe.com/oauth2callback
```

#### Setup Instructions for Cloud Environment

1. **Configure Reverse Proxy:**
   - Set up your n8n container to expose a port for authentication
   - Configure a reverse proxy to forward traffic from your domain (e.g., `gmail.gongrzhe.com`) to this port

2. **DNS Configuration:**
   - Add an A record in your DNS settings to resolve your domain to your cloud server's IP address

3. **Google Cloud Platform Setup:**
   - In your Google Cloud Console, add your custom domain callback URL (e.g., `https://gmail.gongrzhe.com/oauth2callback`) to the authorized redirect URIs list

4. **Run Authentication:**
   ```bash
   npx @gongrzhe/server-gmail-autoauth-mcp auth https://gmail.gongrzhe.com/oauth2callback
   ```

5. **Configure in your application:**
   ```json
   {
     "mcpServers": {
       "gmail": {
         "command": "npx",
         "args": [
           "@gongrzhe/server-gmail-autoauth-mcp"
         ]
       }
     }
   }
   ```

This approach allows authentication flows to work properly in environments where localhost isn't accessible, such as containerized applications or cloud servers.

## OAuth Scopes

You can limit the server's Gmail access by specifying OAuth scopes during authentication. This controls which tools are available to the LLM, reducing the attack surface for sensitive operations.

### Available Scopes

| Scope | Description |
|-------|-------------|
| `gmail.readonly` | Read-only access to emails (search, read, download attachments) |
| `gmail.modify` | Full read/write access to emails (superset of `readonly` - includes sending, modifying, deleting) |
| `gmail.compose` | Create drafts and send emails only |
| `gmail.send` | Send emails only |
| `gmail.labels` | Manage labels only |
| `gmail.settings.basic` | Manage filters and settings |

> **Note**: `gmail.modify` is a superset that includes all read capabilities. You don't need `gmail.readonly` if you have `gmail.modify`.

### Authenticating with Specific Scopes

Use the `--scopes` flag to request only the permissions you need:

```bash
# Read-only access (recommended for safe browsing)
npx @gongrzhe/server-gmail-autoauth-mcp auth --scopes=gmail.readonly

# Read-only with filter management
npx @gongrzhe/server-gmail-autoauth-mcp auth --scopes=gmail.readonly,gmail.settings.basic

# Full access (default behavior)
npx @gongrzhe/server-gmail-autoauth-mcp auth --scopes=gmail.modify,gmail.settings.basic
```

If no `--scopes` flag is provided, the server defaults to `gmail.modify,gmail.settings.basic` for full functionality.

### Scope-to-Tool Mapping

The server automatically filters available tools based on your authorized scopes:

| Tools | Required Scope (any) |
|-------|---------------------|
| `read_email`, `search_emails`, `download_attachment` | `gmail.readonly` or `gmail.modify` |
| `list_email_labels` | `gmail.readonly`, `gmail.modify`, or `gmail.labels` |
| `send_email`, `draft_email`, `reply_all` | `gmail.modify`, `gmail.compose`, or `gmail.send` |
| `schedule_email`, `send_due_scheduled_emails` | `gmail.modify`, `gmail.compose`, or `gmail.send` |
| `list_scheduled_emails` | `gmail.readonly` or `gmail.modify` |
| `cancel_scheduled_email` | `gmail.modify` or `gmail.compose` |
| `modify_email`, `delete_email`, `batch_modify_emails`, `batch_delete_emails` | `gmail.modify` |
| `create_label`, `update_label`, `delete_label`, `get_or_create_label` | `gmail.modify` or `gmail.labels` |
| `list_filters`, `get_filter`, `create_filter`, `delete_filter`, `create_filter_from_template` | `gmail.settings.basic` |

### Re-authenticating

To change your scopes, simply run the auth command again with different scopes. This will replace your existing credentials.

## Claude Code CLI Configuration

To use this MCP server with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), add it to your MCP settings.

### Read-Only Configuration (Recommended for Safe Browsing)

First, authenticate with read-only scope:

```bash
npx @gongrzhe/server-gmail-autoauth-mcp auth --scopes=gmail.readonly
```

Then add to your Claude Code MCP settings (`~/.claude/mcp_settings.json` or project-level `.mcp.json`):

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["@gongrzhe/server-gmail-autoauth-mcp"]
    }
  }
}
```

With read-only scopes, only these 4 tools will be available to Claude:
- `read_email` - Read email content
- `search_emails` - Search your inbox
- `list_email_labels` - List available labels
- `download_attachment` - Download attachments

### Full Access Configuration

For full Gmail management capabilities:

```bash
npx @gongrzhe/server-gmail-autoauth-mcp auth --scopes=gmail.modify,gmail.settings.basic
```

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["@gongrzhe/server-gmail-autoauth-mcp"]
    }
  }
}
```

This enables all 24 tools including sending emails, managing labels, creating filters, reply-all, scheduled send, and batch operations.

## Available Tools

The server provides the following tools that can be used through Claude Desktop:

### 1. Send Email (`send_email`)

Sends a new email immediately. Supports plain text, HTML, or multipart emails **with optional file attachments**.

Basic Email:
```json
{
  "to": ["recipient@example.com"],
  "subject": "Meeting Tomorrow",
  "body": "Hi,\n\nJust a reminder about our meeting tomorrow at 10 AM.\n\nBest regards",
  "cc": ["cc@example.com"],
  "bcc": ["bcc@example.com"],
  "mimeType": "text/plain"
}
```

**Email with Attachments:**
```json
{
  "to": ["recipient@example.com"],
  "subject": "Project Files",
  "body": "Hi,\n\nPlease find the project files attached.\n\nBest regards",
  "attachments": [
    "/path/to/document.pdf",
    "/path/to/spreadsheet.xlsx",
    "/path/to/presentation.pptx"
  ]
}
```

HTML Email Example:
```json
{
  "to": ["recipient@example.com"],
  "subject": "Meeting Tomorrow",
  "mimeType": "text/html",
  "body": "<html><body><h1>Meeting Reminder</h1><p>Just a reminder about our <b>meeting tomorrow</b> at 10 AM.</p><p>Best regards</p></body></html>"
}
```

Multipart Email Example (HTML + Plain Text):
```json
{
  "to": ["recipient@example.com"],
  "subject": "Meeting Tomorrow",
  "mimeType": "multipart/alternative",
  "body": "Hi,\n\nJust a reminder about our meeting tomorrow at 10 AM.\n\nBest regards",
  "htmlBody": "<html><body><h1>Meeting Reminder</h1><p>Just a reminder about our <b>meeting tomorrow</b> at 10 AM.</p><p>Best regards</p></body></html>"
}
```

### 2. Draft Email (`draft_email`)
Creates a draft email without sending it. **Also supports attachments**.

```json
{
  "to": ["recipient@example.com"],
  "subject": "Draft Report",
  "body": "Here's the draft report for your review.",
  "cc": ["manager@example.com"],
  "attachments": ["/path/to/draft_report.docx"]
}
```

#### One draft per thread (`replaceThreadDrafts`)

By default, calling `draft_email` repeatedly on the same `threadId` creates a new draft each time, leaving multiple drafts stacked on one thread. Pass `replaceThreadDrafts: true` to instead delete every existing draft on that thread before the new one is created:

```json
{
  "to": ["recipient@example.com"],
  "subject": "Re: Draft Report",
  "body": "Updated version attached.",
  "threadId": "18abc...",
  "inReplyTo": "<message-id@mail.gmail.com>",
  "replaceThreadDrafts": true
}
```

- **Default is `false`; existing behavior is unchanged unless you opt in.**
- Only applies when `threadId` is provided. If `threadId` is absent there's no thread to scope the replacement to, so the flag is a no-op (the list/delete step is skipped entirely rather than deleting unrelated drafts).
- **Safety note**: this deletes *all* of the authenticated user's drafts on the thread, not just drafts this tool previously created. If a human has their own in-progress draft on that same thread, it will be deleted too. That's why this defaults to off — only pass `true` when you specifically want "one draft per thread" enforced and understand that tradeoff.
- The Gmail API has no server-side way to filter `drafts.list` by `threadId` (its `q` param only supports normal Gmail search syntax), so this works by listing all of the account's drafts, paginating via `nextPageToken`, and filtering client-side on each draft's `message.threadId` (present by default in the `drafts.list` response, no extra `drafts.get` calls needed) before deleting the matches via `drafts.delete`.
- The response lists any drafts that were replaced, e.g. `Replaced 1 existing draft(s) on this thread:\n  - draft r123... (message 18abc...)`. If none matched, nothing is added to the response.

### 3. Read Email (`read_email`)
Retrieves the content of a specific email by its ID. **Now shows enhanced attachment information**.

```json
{
  "messageId": "182ab45cd67ef"
}
```

**Enhanced Response includes attachment details:**
```
Subject: Project Files
From: sender@example.com
To: recipient@example.com
Date: Thu, 19 Jun 2025 10:30:00 -0400

Email body content here...

Attachments (2):
- document.pdf (application/pdf, 245 KB, ID: ANGjdJ9fkTs-i3GCQo5o97f_itG...)
- spreadsheet.xlsx (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, 89 KB, ID: BWHkeL8gkUt-j4HDRp6o98g_juI...)
```

### 4. **Download Attachment (`download_attachment`)**
**NEW**: Downloads email attachments to your local filesystem.

```json
{
  "messageId": "182ab45cd67ef",
  "attachmentId": "ANGjdJ9fkTs-i3GCQo5o97f_itG...",
  "savePath": "/path/to/downloads",
  "filename": "downloaded_document.pdf"
}
```

Parameters:
- `messageId`: The ID of the email containing the attachment
- `attachmentId`: The attachment ID (shown in enhanced email display)
- `savePath`: Directory to save the file (optional, defaults to current directory, only used by `mode: 'file'`)
- `filename`: Custom filename (optional, uses original filename if not provided, only used by `mode: 'file'`)
- `mode`: `'auto'` (default) | `'text'` | `'base64'` | `'file'` — see [Inline attachments](#inline-attachments) below
- `maxBytes`: Max size to return inline for `auto`/`text`/`base64` (default 10 MB)

### Inline attachments

Because this server commonly runs on remote infrastructure (e.g. Cloud Run), a caller often can't read files the server wrote to its own disk, or supply a local file for the server to attach. Inline attachments solve both directions: bytes travel as base64 over MCP instead of through the server's filesystem.

**Attaching a file inline** (`send_email`, `draft_email`, `reply_all`): each entry in `attachments` is either a server file path (legacy) or an object carrying the bytes directly:

```json
{
  "to": ["recipient@example.com"],
  "subject": "Report attached",
  "body": "See attached.",
  "attachments": [
    {
      "filename": "report.pdf",
      "mimeType": "application/pdf",
      "contentBase64": "JVBERi0xLjQKJ..."
    },
    "/path/still/works/too.docx"
  ]
}
```

Total inline attachment bytes (decoded) per email are capped at 20 MB.

**Reading an attachment inline** (`download_attachment`): the `mode` parameter controls how the attachment comes back:

| Mode | Behavior |
|------|----------|
| `auto` (default) | Returns extracted text for PDF, DOCX, XLSX/XLS/CSV, TXT/MD/JSON, and HTML attachments. Falls back to base64 for everything else (e.g. images). |
| `text` | Forces text extraction; returns an error listing supported types if the attachment isn't one of them. |
| `base64` | Always returns `{filename, mimeType, size, contentBase64}` inline — no extraction attempted. |
| `file` | Legacy behavior: saves the attachment to disk on the server and returns the path. |

`auto`/`text`/`base64` are capped at 10 MB by default (override with `maxBytes`); attachments over the cap return an error suggesting `mode: 'file'` or a larger `maxBytes`. Extracted text is capped at 200,000 characters, with a `[truncated: N more characters]` marker appended when cut.

Example — reading a PDF's text without ever touching the server's disk:
```json
{
  "messageId": "182ab45cd67ef",
  "attachmentId": "ANGjdJ9fkTs-i3GCQo5o97f_itG...",
  "mode": "auto"
}
```
returns:
```
Attachment: report.pdf
Type: application/pdf
Size: 48213 bytes
Mode: text (pdf)

<extracted text of the PDF>
```

### 5. Search Emails (`search_emails`)
Searches for emails using Gmail search syntax.

```json
{
  "query": "from:sender@example.com after:2024/01/01 has:attachment",
  "maxResults": 10
}
```

### 6. Modify Email (`modify_email`)
Adds or removes labels from emails (move to different folders, archive, etc.).

```json
{
  "messageId": "182ab45cd67ef",
  "addLabelIds": ["IMPORTANT"],
  "removeLabelIds": ["INBOX"]
}
```

### 7. Delete Email (`delete_email`)
Permanently deletes an email.

```json
{
  "messageId": "182ab45cd67ef"
}
```

### 8. List Email Labels (`list_email_labels`)
Retrieves all available Gmail labels.

```json
{}
```

### 9. Create Label (`create_label`)
Creates a new Gmail label.

```json
{
  "name": "Important Projects",
  "messageListVisibility": "show",
  "labelListVisibility": "labelShow"
}
```

### 10. Update Label (`update_label`)
Updates an existing Gmail label.

```json
{
  "id": "Label_1234567890",
  "name": "Urgent Projects",
  "messageListVisibility": "show",
  "labelListVisibility": "labelShow"
}
```

### 11. Delete Label (`delete_label`)
Deletes a Gmail label.

```json
{
  "id": "Label_1234567890"
}
```

### 12. Get or Create Label (`get_or_create_label`)
Gets an existing label by name or creates it if it doesn't exist.

```json
{
  "name": "Project XYZ",
  "messageListVisibility": "show",
  "labelListVisibility": "labelShow"
}
```

### 13. Batch Modify Emails (`batch_modify_emails`)
Modifies labels for multiple emails in efficient batches.

```json
{
  "messageIds": ["182ab45cd67ef", "182ab45cd67eg", "182ab45cd67eh"],
  "addLabelIds": ["IMPORTANT"],
  "removeLabelIds": ["INBOX"],
  "batchSize": 50
}
```

### 14. Batch Delete Emails (`batch_delete_emails`)
Permanently deletes multiple emails in efficient batches.

```json
{
  "messageIds": ["182ab45cd67ef", "182ab45cd67eg", "182ab45cd67eh"],
  "batchSize": 50
}
```

### 15. Create Filter (`create_filter`)
Creates a new Gmail filter with custom criteria and actions.

```json
{
  "criteria": {
    "from": "newsletter@company.com",
    "hasAttachment": false
  },
  "action": {
    "addLabelIds": ["Label_Newsletter"],
    "removeLabelIds": ["INBOX"]
  }
}
```

### 16. List Filters (`list_filters`)
Retrieves all Gmail filters.

```json
{}
```

### 17. Get Filter (`get_filter`)
Gets details of a specific Gmail filter.

```json
{
  "filterId": "ANe1Bmj1234567890"
}
```

### 18. Delete Filter (`delete_filter`)
Deletes a Gmail filter.

```json
{
  "filterId": "ANe1Bmj1234567890"
}
```

### 19. Create Filter from Template (`create_filter_from_template`)
Creates a filter using pre-defined templates for common scenarios.

```json
{
  "template": "fromSender",
  "parameters": {
    "senderEmail": "notifications@github.com",
    "labelIds": ["Label_GitHub"],
    "archive": true
  }
}
```

### 20. Reply All (`reply_all`)
Replies to all recipients of an email. Automatically fetches the original email to build the recipient list and sets proper threading headers (`In-Reply-To`, `References`, `threadId`).

**How it works:**
1. Fetches the original email by `messageId`
2. Builds **To** from the original sender (From header)
3. Builds **CC** from original To + CC, excluding your own email
4. Sets threading headers so the reply lands in the correct thread
5. Sends via the existing `send_email` pipeline (supports attachments, HTML, multipart)

```json
{
  "messageId": "182ab45cd67ef",
  "body": "Thanks for the update, everyone. I'll review and get back to you.",
  "mimeType": "text/plain"
}
```

**With HTML and attachments:**
```json
{
  "messageId": "182ab45cd67ef",
  "body": "Plain text fallback",
  "htmlBody": "<p>Thanks for the update. See attached notes.</p>",
  "mimeType": "multipart/alternative",
  "attachments": ["/path/to/notes.pdf"]
}
```

Parameters:
- `messageId` (required): ID of the email to reply to
- `body` (required): Reply body (plain text, or fallback when using multipart)
- `htmlBody` (optional): HTML version of the reply body
- `mimeType` (optional): `text/plain` (default), `text/html`, or `multipart/alternative`
- `attachments` (optional): Array of file paths to attach

### 21. Schedule Email (`schedule_email`)

Composes an email exactly like `draft_email` (same fields: `to`, `subject`, `body`, `htmlBody`, `cc`, `bcc`, `threadId`, `inReplyTo`, `attachments`, `skipQuote`), plus a required `sendAt`, and queues it to send automatically at that time.

**Why this exists:** the Gmail API has no native schedule-send endpoint. `users.messages.send` and `users.drafts.send` both send immediately, and the "Schedule send" button in the Gmail web UI is a client-side-only feature with no API surface. This tool implements scheduling on top of what the API does offer:

1. It creates a normal Gmail draft (through the same threading/quoting/attachment pipeline as `draft_email`).
2. It stamps the draft's raw message with an `X-Scheduled-Send-At` header carrying the resolved UTC time.
3. It applies a `Scheduled` user label to the draft.

The draft is fully visible and editable in Gmail like any other draft the whole time it's pending. A periodic job calls `send_due_scheduled_emails` (see below), which finds every `Scheduled`-labeled draft whose time has passed and calls `drafts.send` on it, sending the exact composed message and removing it from Drafts, same as if a person clicked Send.

```json
{
  "to": ["recipient@example.com"],
  "subject": "Friday Notes",
  "body": "Here's this week's newsletter...",
  "sendAt": "2026-08-21T08:00:00-04:00"
}
```

Parameters:
- All `draft_email` parameters
- `sendAt` (required): ISO 8601 date-time with a timezone offset or `Z` (a bare local time is ambiguous), must be in the future

### 22. List Scheduled Emails (`list_scheduled_emails`)

Lists every pending scheduled send (drafts under the `Scheduled` label), soonest first, with recipient, subject, and target send time.

```json
{
  "maxResults": 20
}
```

### 23. Cancel Scheduled Email (`cancel_scheduled_email`)

Cancels a scheduled send. By default this only removes the `Scheduled` label: the draft itself is untouched and reverts to a normal editable draft that will never be auto-sent. Pass `permanentlyDelete: true` to remove the draft outright instead.

```json
{
  "draftId": "r-1234567890",
  "permanentlyDelete": false
}
```

### 24. Send Due Scheduled Emails (`send_due_scheduled_emails`)

The trigger tool: sends every scheduled email whose `sendAt` has passed. This isn't something the agent calls during normal email processing; it's meant to be invoked on a timer (a Cloud Scheduler job hitting this server's `/mcp` endpoint with a `tools/call` request, the same way any other tool call works). Takes no arguments. Returns a summary of what was sent, what's still pending, and any per-item errors (one failure doesn't block the rest of the sweep). See [deploy/SETUP.md](../deploy/SETUP.md) in the `enrichment` repo for the Cloud Scheduler job configuration.

## Filter Management Features

### Filter Criteria

You can create filters based on various criteria:

| Criteria | Example | Description |
|----------|---------|-------------|
| `from` | `"sender@example.com"` | Emails from a specific sender |
| `to` | `"recipient@example.com"` | Emails sent to a specific recipient |
| `subject` | `"Meeting"` | Emails with specific text in subject |
| `query` | `"has:attachment"` | Gmail search query syntax |
| `negatedQuery` | `"spam"` | Text that must NOT be present |
| `hasAttachment` | `true` | Emails with attachments |
| `size` | `10485760` | Email size in bytes |
| `sizeComparison` | `"larger"` | Size comparison (`larger`, `smaller`) |

### Filter Actions

Filters can perform the following actions:

| Action | Example | Description |
|--------|---------|-------------|
| `addLabelIds` | `["IMPORTANT", "Label_Work"]` | Add labels to matching emails |
| `removeLabelIds` | `["INBOX", "UNREAD"]` | Remove labels from matching emails |
| `forward` | `"backup@example.com"` | Forward emails to another address |

### Filter Templates

The server includes pre-built templates for common filtering scenarios:

#### 1. From Sender Template (`fromSender`)
Filters emails from a specific sender and optionally archives them.

```json
{
  "template": "fromSender",
  "parameters": {
    "senderEmail": "newsletter@company.com",
    "labelIds": ["Label_Newsletter"],
    "archive": true
  }
}
```

#### 2. Subject Filter Template (`withSubject`)
Filters emails with specific subject text and optionally marks as read.

```json
{
  "template": "withSubject",
  "parameters": {
    "subjectText": "[URGENT]",
    "labelIds": ["Label_Urgent"],
    "markAsRead": false
  }
}
```

#### 3. Attachment Filter Template (`withAttachments`)
Filters all emails with attachments.

```json
{
  "template": "withAttachments",
  "parameters": {
    "labelIds": ["Label_Attachments"]
  }
}
```

#### 4. Large Email Template (`largeEmails`)
Filters emails larger than a specified size.

```json
{
  "template": "largeEmails",
  "parameters": {
    "sizeInBytes": 10485760,
    "labelIds": ["Label_Large"]
  }
}
```

#### 5. Content Filter Template (`containingText`)
Filters emails containing specific text and optionally marks as important.

```json
{
  "template": "containingText",
  "parameters": {
    "searchText": "invoice",
    "labelIds": ["Label_Finance"],
    "markImportant": true
  }
}
```

#### 6. Mailing List Template (`mailingList`)
Filters mailing list emails and optionally archives them.

```json
{
  "template": "mailingList",
  "parameters": {
    "listIdentifier": "dev-team",
    "labelIds": ["Label_DevTeam"],
    "archive": true
  }
}
```

### Common Filter Examples

Here are some practical filter examples:

**Auto-organize newsletters:**
```json
{
  "criteria": {
    "from": "newsletter@company.com"
  },
  "action": {
    "addLabelIds": ["Label_Newsletter"],
    "removeLabelIds": ["INBOX"]
  }
}
```

**Handle promotional emails:**
```json
{
  "criteria": {
    "query": "unsubscribe OR promotional"
  },
  "action": {
    "addLabelIds": ["Label_Promotions"],
    "removeLabelIds": ["INBOX", "UNREAD"]
  }
}
```

**Priority emails from boss:**
```json
{
  "criteria": {
    "from": "boss@company.com"
  },
  "action": {
    "addLabelIds": ["IMPORTANT", "Label_Boss"]
  }
}
```

**Large attachments:**
```json
{
  "criteria": {
    "size": 10485760,
    "sizeComparison": "larger",
    "hasAttachment": true
  },
  "action": {
    "addLabelIds": ["Label_LargeFiles"]
  }
}
```

## Advanced Search Syntax

The `search_emails` tool supports Gmail's powerful search operators:

| Operator | Example | Description |
|----------|---------|-------------|
| `from:` | `from:john@example.com` | Emails from a specific sender |
| `to:` | `to:mary@example.com` | Emails sent to a specific recipient |
| `subject:` | `subject:"meeting notes"` | Emails with specific text in the subject |
| `has:attachment` | `has:attachment` | Emails with attachments |
| `after:` | `after:2024/01/01` | Emails received after a date |
| `before:` | `before:2024/02/01` | Emails received before a date |
| `is:` | `is:unread` | Emails with a specific state |
| `label:` | `label:work` | Emails with a specific label |

You can combine multiple operators: `from:john@example.com after:2024/01/01 has:attachment`

## Advanced Features

### **Email Attachment Support**

The server provides comprehensive attachment functionality:

- **Sending Attachments**: Include file paths in the `attachments` array when sending or drafting emails
- **Attachment Detection**: Automatically detects MIME types and file sizes
- **Download Capability**: Download any email attachment to your local filesystem
- **Enhanced Display**: View detailed attachment information including filenames, types, sizes, and download IDs
- **Multiple Formats**: Support for all common file types (documents, images, archives, etc.)
- **RFC822 Compliance**: Uses Nodemailer for proper MIME message formatting

**Supported File Types**: All standard file types including PDF, DOCX, XLSX, PPTX, images (PNG, JPG, GIF), archives (ZIP, RAR), and more.

### Email Content Extraction

The server intelligently extracts email content from complex MIME structures:

- Prioritizes plain text content when available
- Falls back to HTML content if plain text is not available
- Handles multi-part MIME messages with nested parts
- **Processes attachments information (filename, type, size, download ID)**
- Preserves original email headers (From, To, Subject, Date)

### International Character Support

The server fully supports non-ASCII characters in email subjects and content, including:
- Turkish, Chinese, Japanese, Korean, and other non-Latin alphabets
- Special characters and symbols
- Proper encoding ensures correct display in email clients

### Comprehensive Label Management

The server provides a complete set of tools for managing Gmail labels:

- **Create Labels**: Create new labels with customizable visibility settings
- **Update Labels**: Rename labels or change their visibility settings
- **Delete Labels**: Remove user-created labels (system labels are protected)
- **Find or Create**: Get a label by name or automatically create it if not found
- **List All Labels**: View all system and user labels with detailed information
- **Label Visibility Options**: Control how labels appear in message and label lists

Label visibility settings include:
- `messageListVisibility`: Controls whether the label appears in the message list (`show` or `hide`)
- `labelListVisibility`: Controls how the label appears in the label list (`labelShow`, `labelShowIfUnread`, or `labelHide`)

These label management features enable sophisticated organization of emails directly through Claude, without needing to switch to the Gmail interface.

### Batch Operations

The server includes efficient batch processing capabilities:

- Process up to 50 emails at once (configurable batch size)
- Automatic chunking of large email sets to avoid API limits
- Detailed success/failure reporting for each operation
- Graceful error handling with individual retries
- Perfect for bulk inbox management and organization tasks

## Security Notes

- OAuth credentials are stored securely in your local environment (`~/.gmail-mcp/`)
- The server uses offline access to maintain persistent authentication
- Never share or commit your credentials to version control
- Regularly review and revoke unused access in your Google Account settings
- Credentials are stored globally but are only accessible by the current user
- **Attachment files are processed locally and never stored permanently by the server**

## Troubleshooting

1. **OAuth Keys Not Found**
   - Make sure `gcp-oauth.keys.json` is in either your current directory or `~/.gmail-mcp/`
   - Check file permissions

2. **Invalid Credentials Format**
   - Ensure your OAuth keys file contains either `web` or `installed` credentials
   - For web applications, verify the redirect URI is correctly configured

3. **Port Already in Use**
   - If port 3000 is already in use, please free it up before running authentication
   - You can find and stop the process using that port

4. **Batch Operation Failures**
   - If batch operations fail, they automatically retry individual items
   - Check the detailed error messages for specific failures
   - Consider reducing the batch size if you encounter rate limiting

5. **Attachment Issues**
   - **File Not Found**: Ensure attachment file paths are correct and accessible
   - **Permission Errors**: Check that the server has read access to attachment files
   - **Size Limits**: Gmail has a 25MB attachment size limit per email
   - **Download Failures**: Verify you have write permissions to the download directory

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

**CI requires README updates** — every push to `main` and every PR must include a README.md change (even a version bump or changelog entry). This ensures documentation stays current as the codebase evolves.

To bypass for commits that genuinely don't need a docs update (dependency bumps, CI config changes), include `[skip-readme]` or `[no-readme]` in your commit message or PR title.


## Running evals

The evals package loads an mcp client that then runs the index.ts file, so there is no need to rebuild between tests. You can load environment variables by prefixing the npx command. Full documentation can be found [here](https://www.mcpevals.io/docs).

```bash
OPENAI_API_KEY=your-key  npx mcp-eval src/evals/evals.ts src/index.ts
```

## License

MIT

## Support

If you encounter any issues or have questions, please [file an issue](https://github.com/ArtyMcLabin/Gmail-MCP-Server/issues).
