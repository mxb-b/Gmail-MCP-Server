# Deploying scheduled send

This covers the one piece of scheduled send that isn't just new MCP tools: the
Cloud Scheduler job that periodically triggers `send_due_scheduled_emails` so
queued drafts actually go out on time.

## Background: why a trigger, not new infrastructure

The Gmail API has no native schedule-send endpoint (`users.messages.send` and
`users.drafts.send` both send immediately; Gmail's own "Schedule send" button is
a web-UI-only feature). `schedule_email` works around this by creating a
labeled draft with an `X-Scheduled-Send-At` header (see the README's
[Scheduled send](../README.md#21-schedule-email-schedule_email) section and
`src/scheduled-send.ts`). All state lives in Gmail itself, no database.

Something still has to notice when a scheduled time arrives and call
`drafts.send`. Three options were considered:

1. **Cloud Scheduler hitting a new bespoke HTTP endpoint on the Cloud Run
   service.** Rejected: the container only runs `supergateway`, a generic
   stdio-to-HTTP MCP bridge (see `Dockerfile` / `entrypoint.sh` in the
   `enrichment` repo's `deploy/` folder). It exposes exactly `/mcp` (MCP
   JSON-RPC) and `/health`; there's no app code in the container to attach an
   extra route to without forking supergateway or adding a second process.
2. **A separate always-on process (Cloud Run job, Cloud Function) with its own
   persistent store (Firestore/GCS/Supabase) tracking scheduled sends.**
   Rejected as unnecessary: it duplicates state that already lives correctly in
   Gmail (the draft, the label, the header), adds a new credential/IAM surface,
   and a new failure mode (the two stores disagreeing).
3. **Cloud Scheduler calling the existing `/mcp` endpoint directly, exactly
   like any other MCP client, with a `tools/call` request for
   `send_due_scheduled_emails`.** Chosen. Zero new infrastructure: the
   trigger is just another caller of the same JSON-RPC surface `gmail-mcp-call.sh`
   already uses. The tool itself does the label lookup, the time comparison,
   and the `drafts.send` calls.

## Cloud Scheduler job

Not yet created; this is what will run once approved. Replace
`SERVICE_URL` with the deployed Cloud Run URL
(`https://gmail-mcp-211363952558.us-central1.run.app` at the time of writing).

```bash
gcloud scheduler jobs create http gmail-mcp-scheduled-send \
  --location=us-central1 \
  --schedule="*/5 * * * *" \
  --uri="SERVICE_URL/mcp" \
  --http-method=POST \
  --headers="Content-Type=application/json,Accept=application/json, text/event-stream" \
  --message-body='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_due_scheduled_emails","arguments":{}}}' \
  --time-zone="America/New_York"
```

Every 5 minutes is the suggested interval: frequent enough that a scheduled
9:00am send actually leaves around 9:00-9:05, infrequent enough to stay
comfortably inside Cloud Run's free tier (this job alone is ~8,640
requests/month, well under the 2M/month free allotment noted in
`deploy/SETUP.md`).

To update or delete it later:

```bash
gcloud scheduler jobs update http gmail-mcp-scheduled-send --location=us-central1 --schedule="*/5 * * * *"
gcloud scheduler jobs delete gmail-mcp-scheduled-send --location=us-central1
```

To verify manually before wiring up the schedule:

```bash
gcloud scheduler jobs run gmail-mcp-scheduled-send --location=us-central1
gcloud scheduler jobs describe gmail-mcp-scheduled-send --location=us-central1
```

This also requires enabling the Cloud Scheduler API on the project once:

```bash
gcloud services enable cloudscheduler.googleapis.com
```

## Known gap: the endpoint is unauthenticated

The Cloud Run service currently allows unauthenticated invocations (that's why
`gmail-mcp-call.sh` and the curl examples in `CLAUDE.md` send no auth header).
This is a pre-existing condition, not something scheduled send introduces:
anyone with the URL can already call `send_email` today. Scheduled send adds a
second door (a timer that fires sends automatically) behind the same
unauthenticated surface, so it's worth flagging explicitly:

- **Not a new risk in practice**, since `send_email` was already reachable.
- **Worth hardening eventually**: require the Cloud Run service to authenticate
  requests (`gcloud run services update gmail-mcp --no-allow-unauthenticated`)
  and have Cloud Scheduler authenticate via an OIDC token
  (`--oidc-service-account-email=...` on the scheduler job, with a matching
  `roles/run.invoker` binding). Doing this for the whole service would also
  require reworking every other caller (claude.ai's custom connector, the
  agent's curl calls) to send an OIDC/ID token, which is a larger change than
  this task. Flagging for Jordan/mxb-b to decide whether to do now or later.

## Rollout checklist (nothing below has been run yet)

1. Merge/deploy the `feature/schedule-send` branch to `main` on
   [mxb-b/Gmail-MCP-Server](https://github.com/mxb-b/Gmail-MCP-Server) (follow
   `.claude/skills/pr-review-sop/SKILL.md`: mandatory security audit before
   merging).
2. Re-run `deploy/setup.sh` from the `enrichment` repo (or `gcloud run deploy`
   directly) to rebuild the Cloud Run image from the new `main`. The
   `Dockerfile` clones the fork fresh on every build, so no image changes are
   needed beyond the fork itself.
3. `gcloud services enable cloudscheduler.googleapis.com` (one-time, if not
   already enabled on this project).
4. Create the Cloud Scheduler job (command above).
5. Smoke test: call `schedule_email` with a `sendAt` ~2 minutes out, then
   either wait for the next scheduler tick or run the job manually
   (`gcloud scheduler jobs run ...`), then confirm via `list_scheduled_emails`
   (should be empty) and Gmail's Sent folder that it actually sent.
6. Add a short pointer to this doc from the `enrichment` repo's
   `deploy/SETUP.md` (that file lives in a different checkout than this one;
   whoever runs the deploy should add a "## Scheduled send" section there
   linking here, similar to the existing "Usage: Mark as Read & Archive"
   section).
