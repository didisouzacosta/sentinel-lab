<div align="center">
  <a href="#">
    <h1 style="font-size: 4rem;">🛡️</h1>
    <h1>Workers Sentinel</h1>
  </a>
</div>

<p align="center">
    <em>A self-hosted error tracking system with Sentry SDK ingestion compatibility, running entirely on Cloudflare Workers</em>
</p>

<p align="center">
    <a href="https://github.com/G4brym/workers-sentinel/commits/main" target="_blank">
      <img src="https://img.shields.io/github/commit-activity/m/G4brym/workers-sentinel?label=Commits&style=social" alt="Workers Sentinel Commits">
    </a>
    <a href="https://github.com/G4brym/workers-sentinel/issues" target="_blank">
      <img src="https://img.shields.io/github/issues/G4brym/workers-sentinel?style=social" alt="Issues">
    </a>
    <a href="https://github.com/G4brym/workers-sentinel/blob/main/LICENSE" target="_blank">
      <img src="https://img.shields.io/badge/license-MIT-brightgreen.svg?style=social" alt="Software License">
    </a>
</p>

# Workers Sentinel

> **⚠️ Disclaimer:** This is a toy project and a very poor imitation of Sentry. It doesn't even represent 0.1% of all Sentry features. This should not be taken seriously or used in any production environment where you actually care about error tracking. Please use the real [Sentry](https://sentry.io) for production workloads.

Workers Sentinel is a lightweight, self-hosted error tracking and monitoring solution that runs entirely on your Cloudflare account. It accepts events using the Sentry SDK wire format, allowing you to use existing Sentry SDKs by simply changing the DSN endpoint. All your error data is stored securely in SQLite-backed Durable Objects, giving you full control over your information.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/G4brym/workers-sentinel/tree/main/template)

## Table of Contents

- [Overview](#overview)
- [Why Workers Sentinel?](#why-workers-sentinel)
- [Key Features](#key-features)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [SDK Configuration](#sdk-configuration)
- [Debug files (dSYM and ProGuard/R8)](#debug-files-dsym-and-proguardr8)
- [Webhook Notifications](#webhook-notifications)
- [API Tokens](#api-tokens)
- [Architecture](#architecture)
- [Roadmap & Future Enhancements](#roadmap--future-enhancements)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

## Overview

Workers Sentinel gives you a private, self-hosted error tracking solution with a modern web dashboard. By leveraging the Cloudflare ecosystem, it offers a cost-effective and scalable alternative to hosted error tracking services. All your data is stored in your own Durable Objects with SQLite storage (and attachment payloads in your own R2 bucket), giving you complete control and privacy.

## Why Workers Sentinel?

**🔒 Privacy First**
- All data stays in YOUR Cloudflare account
- No third-party tracking or data sharing
- You control your error data completely

**💰 Cost-Effective**
- Runs on Cloudflare's generous free tier
- Pay only for what you use beyond free limits
- No monthly subscription fees

**⚡ Performance**
- Built on Cloudflare's global edge network
- Fast error ingestion worldwide
- Serverless architecture scales automatically

**🔌 SDK Compatible**
- Works with existing Sentry SDKs
- Just change your DSN endpoint
- Supports JavaScript, Python, Go, and more

**🎨 Modern Dashboard**
- Project overview with error trend charts and key metrics
- Clean, intuitive interface
- Stack trace visualization
- Issue grouping and management

**🛠️ Easy Setup**
- Deploy with one click
- Automatic project creation
- Smart authentication setup

## Key Features

- **🔌 Sentry SDK Compatible**: Use existing Sentry SDKs by changing only the DSN endpoint
- **🔒 Secure & Private**: Self-hosted on your Cloudflare account with no third-party data access
- **🔐 Smart Authentication**: Automatic first-user admin setup with session-based auth
- **🔑 Passkeys (WebAuthn)**: Register named passkeys and sign in usernameless with a fingerprint, face, or security key — no password needed; managed from the account Settings page
- **📊 Issue Grouping**: Automatic fingerprinting groups similar errors into issues
- **📈 Project Overview Dashboard**: At-a-glance error health with trend charts, metric cards, and top active issues
- **📈 Event Statistics**: Track error frequency with hourly aggregations
- **🔍 Stack Traces**: Full stack trace visualization with code context
- **👥 User Tracking**: See how many users are affected by each issue
- **🏷️ Tags & Context**: View tags, breadcrumbs, and contextual data
- **🔎 Tag-Based Filtering**: Search and filter issues by tag key-value pairs (e.g., browser, OS, environment)
- **✅ Issue Management**: Mark issues as resolved or ignored, or snooze them to revisit later
- **⏰ Issue Snooze**: Temporarily hide issues for a configurable duration (1h, 1d, 3d, 1w) with automatic un-snooze via Durable Object alarms
- **🌍 Environment Filtering**: View errors from specific environments (production, staging, development) separately
- **💬 Comments & Activity Timeline**: Post comments on issues and view a unified activity feed of comments and status changes
- **🌐 Multi-Project**: Multiple projects with isolated data storage
- **🛠️ Administration**: A passkey-gated admin area (Users, Projects, Settings, Audit) where admins create users and projects, reassign project ownership, manage all project membership centrally, and toggle registration — with every action recorded in an audit log
- **👥 Team Membership**: Project rosters are visible to members and managed centrally by administrators with role-based access control (owner/admin/member)
- **🔔 Webhook Notifications**: Get notified when new issues are detected via Slack, Discord, or any HTTP endpoint
- **⚡ Rate Limiting**: Configurable per-project event quotas to prevent runaway error loops from overwhelming the system
- **🗑️ Data Retention**: Configurable per-project retention policies with automatic cleanup
- **🗺️ Source Maps**: Upload source maps per release to resolve minified stack traces back to original source locations
- **📎 Attachments**: Store attachment payloads up to 21 MiB per envelope in Cloudflare R2 — binary supported, downloads with `Range` support, and a Sentry-compatible `/api/0` read surface for event attachments
- **🚫 Inbound Filters**: Drop noisy events before storage with server-side filters (message, exception type, IP address, release, environment)

## Prerequisites

Before deploying Workers Sentinel, make sure you have:

- **Cloudflare Account** - [Sign up for free](https://dash.cloudflare.com/sign-up)
- **Node.js 20+** - For local development (not required for one-click deployment)

**Cloudflare Services Used:**
- Workers (Compute)
- Durable Objects with SQLite (State management)
- R2 (Attachment payloads)
- Workers Assets (Dashboard hosting)

All these services have generous free tiers sufficient for most use cases.

## Getting Started

### One-Click Deploy

Use the "Deploy to Cloudflare" button above, or run:

```bash
npm create cloudflare@latest -- --template=https://github.com/G4brym/workers-sentinel/tree/main/template
```

### Manual Deployment

```bash
# Clone the repository
git clone https://github.com/G4brym/workers-sentinel.git
cd workers-sentinel

# Install dependencies
pnpm install

# Build and deploy
pnpm deploy
```

> **Sentinel Lab fork:** `main` deploys itself to sentinel.adrianosouzacosta.com.br through GitHub Actions
> (lint → tests → deploy → smoke checks, with automatic rollback). See "Continuous deployment" in
> [AGENTS.md](AGENTS.md).

### Local Development (guarded supervisor)

Run the full stack locally under Workerd — no Cloudflare account or credentials needed:

```bash
just install            # pnpm install across the workspace (mise pins node/pnpm/just via mise.toml)
just dev-up             # foreground local supervisor: dashboard + worker + Durable Objects on 127.0.0.1
just send-demo-events   # seed a demo user/project/events to see ingestion and grouping
just dev-down           # authenticated stop from another terminal
```

The supervisor (in `_devenv/cloudflare/`) is loopback-only, persists Durable Object state under `_devenv/cloudflare/.state/`, and strips Cloudflare credentials from child processes so local development cannot reach your Cloudflare account. See AGENTS.md for the full command list and the stale-state reconciliation runbook.

### First-Time Setup

1. **Deploy your worker** to Cloudflare
2. **Visit your worker URL** in a browser
3. **Register the first user** - this becomes your admin account
4. **Create your first project** - you'll receive a DSN
5. **Configure your Sentry SDK** with the DSN

## SDK Configuration

Workers Sentinel speaks the Sentry **ingestion** protocol (envelope and legacy store endpoints, DSN auth) — use your Sentinel DSN wherever a Sentry DSN works. Like Sentry, the DSN may travel only in the envelope header (`{"dsn": "…"}` on the first line), so SDK tunnels and SDK-less senders (a plain `fetch` or `navigator.sendBeacon` of a hand-built envelope, handy on Workers and Deno) need no other credential. The fetch side has two surfaces: a native JSON API (`/api/projects/…`) for the dashboard, and a Sentry-shaped `/api/0` API for agents and Sentry-speaking clients — project/issue discovery, issue triage (`PUT {"status":"resolved"}` marks complete), events, event-id lookup, comments, and event attachments (list/metadata/`?download` byte stream) with Sentry's serializers, `Link` pagination, and `{"detail": …}` errors. `sentry-cli` works for debug files (`debug-files upload`, `upload-proguard`; see [Debug files](#debug-files-dsym-and-proguardr8)); its other commands (releases, source maps) are not supported. See AGENTS.md ("The `/api/0` API") for the exact contract and deviations.

### Platforms

Step-by-step guides with your DSN filled in live in the dashboard (**Connect → SDKs**); they come from one catalog, [`packages/workers-sentinel/src/lib/platforms.ts`](packages/workers-sentinel/src/lib/platforms.ts), which the admin project form also uses (and the planned Sentinel MCP will serve). This table mirrors it.

| Platform | Project `platform` | SDK | Status |
|---|---|---|---|
| Browser | `javascript` | `@sentry/browser` | ✅ tested (`lab/web`, official build) |
| Node.js | `node` | `@sentry/node` | ✅ tested (`lab/node-test.mjs`) |
| Cloudflare Workers (incl. Hono) | `cloudflare-workers` | `@sentry/cloudflare` | Sentry protocol, not run here yet |
| Astro | `javascript-astro` | `@sentry/browser` (+ the Workers guide for server routes) | Sentry protocol, not run here yet |
| Deno | `deno` | `npm:@sentry/deno` | Sentry protocol, not run here yet |
| Bun | `bun` | `@sentry/bun` | Sentry protocol, not run here yet |
| Python | `python` | `sentry-sdk` | Sentry protocol, not run here yet |
| PHP | `php` | `sentry/sentry` | ✅ tested (`lab/php`, `^4`) |
| iOS | `cocoa` | [SentinelKit](https://github.com/didisouzacosta/sentinel-ios) (SPM, iOS 15+, Swift 6+) | ✅ tested (SentinelKit contract envelope accepted by the worker) — consent required by default; dSYM upload ✅, symbolication next |
| Android | `android` | `io.sentry:sentry-android` | ✅ tested (`lab/native-test.mjs`) — mapping upload ✅, deobfuscation next |
| No SDK (envelope) | `envelope` | — (one `fetch`) | ✅ tested (`test/ingestion-envelope-dsn.test.ts`) |
| Other (Go, Ruby, .NET, Rust…) | `other` | that language's Sentry SDK | Sentry protocol, not run here yet |

Notes that trip people up:

- **Hono on Workers** handles errors in `app.onError`, so `withSentry` never sees them — call `Sentry.captureException(err)` there.
- **A Deno codebase deployed to Cloudflare** runs on Workers, not Deno: use the Workers or No SDK guide.
- **Browser and Astro** need the Sentinel origin in the page's CSP `connect-src`.
- **The DSN is public by design**: it can only send events, so it may ship in browser bundles. API tokens (`wst_…`) are the secrets.

### Cloudflare Workers (Service Binding with RPC)

For Cloudflare Workers, you can use [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) with RPC for optimal performance. This routes requests internally within Cloudflare's network, avoiding external HTTP roundtrips and reducing latency.

**Step 1:** Add a service binding to your worker's `wrangler.jsonc`:

```jsonc
{
  "name": "my-worker",
  "main": "src/index.ts",
  "compatibility_flags": ["nodejs_als"],
  "services": [
    { "binding": "SENTINEL", "service": "workers-sentinel", "entrypoint": "SentinelRpc" }
  ]
}
```

**Step 2:** Initialize Sentry with the RPC transport:

```typescript
import * as Sentry from '@sentry/cloudflare';
import { waitUntil } from 'cloudflare:workers';

const DSN = 'https://<public_key>@<your-worker>.workers.dev/<project_id>';

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: DSN,
    transport: () => ({
      send: async (envelope) => {
        const rpcPromise = env.SENTINEL.captureEnvelope(DSN, envelope);
        waitUntil(rpcPromise);
        const result = await rpcPromise;
        return { statusCode: result.status };
      },
      flush: async () => true,
    }),
  }),
  {
    async fetch(request, env, ctx) {
      // Your worker code here
      return new Response('Hello!');
    },
  }
);
```

The `waitUntil` call ensures the RPC completes even after the HTTP response returns. The `captureEnvelope` method takes the DSN and envelope, handling authentication and ingestion internally.

### JavaScript / Browser

```javascript
import * as Sentry from '@sentry/browser';

Sentry.init({
  dsn: 'https://<public_key>@<your-worker>.workers.dev/<project_id>',
});
```

### Node.js

```javascript
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: 'https://<public_key>@<your-worker>.workers.dev/<project_id>',
});
```

### Python

```python
import sentry_sdk

sentry_sdk.init(
    dsn="https://<public_key>@<your-worker>.workers.dev/<project_id>",
)
```

### Go

```go
import "github.com/getsentry/sentry-go"

sentry.Init(sentry.ClientOptions{
    Dsn: "https://<public_key>@<your-worker>.workers.dev/<project_id>",
})
```

The DSN is displayed when you create a project in the dashboard, or you can find it in the project settings.

## MCP (AI agents)

Sentinel has its own [MCP](https://modelcontextprotocol.io) server at `/mcp`. Connect it once and an agent (Claude Code, or any MCP client) can set up and manage your projects from the chat: create a project and get its DSN, read a step-by-step setup guide for the app's platform, send a test event, triage issues with their stack traces, change settings, rotate the DSN key or delete a project.

```bash
claude mcp add --transport http sentinel https://your-sentinel.example.com/mcp \
  --header "Authorization: Bearer wst_…"
```

Other clients: `{"mcpServers": {"sentinel": {"type": "http", "url": "https://your-sentinel.example.com/mcp", "headers": {"Authorization": "Bearer wst_…"}}}}`.

The agent acts **as the token's owner**: with their role in each project (owner, admin, member) and only within the token's access (Read only, Read & write, Projects — see [API Tokens](#api-tokens)). Tools the token can never use are not even listed; destructive ones (`rotate_dsn`, `delete_project`) need the project slug repeated, and MCP clients ask before running anything that changes data. Users, membership and instance settings are never reachable through it. The dashboard's **Connect → MCP** tab has the exact command for your instance. (The official Sentry MCP server also works against the `/api/0` API, for reading and triage only.)

## Debug files (dSYM and ProGuard/R8)

Release builds of native apps report crashes as addresses (iOS) or obfuscated names (Android). The files that turn them back into code — **dSYMs** and **R8/ProGuard `mapping.txt`** — can be sent to Sentinel from the command line, CI, Xcode or an agent. Each crash's `debug_meta` names the files it needs; Sentinel tells you which are stored and which are missing.

> **Status:** upload, storage, the missing-file check and symbolication are live: crashes whose files are stored arrive with function names, files and lines (iOS) and with the real class, method and exception names (Android). The dashboard still shows frames the way it did; native frame details and reprocessing are the next steps ([plan](docs/plano-debug-files.md)).

### Server setup (once, by the operator)

Debug files live in their own R2 bucket and large sentry-cli uploads are assembled by a queue consumer. Both are declared in `wrangler.jsonc` (`DEBUG_FILES`, `PROCESS_QUEUE`) and must exist before deploying:

```bash
npx wrangler r2 bucket create sentinel-lab-debug-files
npx wrangler r2 bucket lifecycle add sentinel-lab-debug-files expire-chunks chunks/ --expire-days 1
npx wrangler r2 bucket lifecycle add sentinel-lab-debug-files expire-staging staging/ --expire-days 1
npx wrangler queues create sentinel-lab-process
```

Without the bucket binding the debug-file routes answer `503 debug_files_unconfigured`; without the queue every assembly runs inside the request.

### Symbolication

Symbolication runs [Symbolicator](https://github.com/getsentry/symbolicator) (FSL-1.1-MIT, fine for self-hosting) in a **Cloudflare Container** next to the Worker (`symbolicator/Dockerfile`, class `Symbolicator` in `src/symbolicator.ts`). It needs:

- the **Workers Paid** plan (Containers);
- **Docker** wherever `wrangler deploy` runs: it builds the image and pushes it to your account (GitHub's `ubuntu-latest` runners have it);
- an API token that can deploy Containers, if you deploy from CI.

No extra secret or R2 token: the container has no internet access, and the only address it can reach is `http://sentinel.internal`, which the Worker answers from the debug-files bucket (outbound interception). Each project gets its own instance (up to 10 running at once), and the Worker serves a project's debug files only to that project's instance, so a malicious debug file could at worst reach its own project's files. An instance sleeps 3 minutes after its last crash; the first crash after that waits a few seconds for it to start (the SDK is not kept waiting).

How events flow:

1. An event whose `debug_meta` names a stored dSYM or mapping is not stored right away: it waits in the queue (`sentinel-lab-process`) and the SDK gets its `200` with the event id at once.
2. The queue consumer sends its frames to Symbolicator and merges the answer: functions, files and lines for native frames (inlined functions become extra frames); class, method and exception names for Android. The original frames stay in `raw_stacktrace`.
3. The event is stored with the tag `symbolication` = `done`, `missing` (the files did not match any frame), `failed`, or `skipped` (over the project's symbolication budget, see below).

Things to know:

- **Nothing is lost.** If the container cannot answer, the job is retried every minute; after about 4 minutes the event is stored as received, tagged `symbolication:failed`. If Symbolicator refuses the request itself, or the symbolicated event is too big to store, the event is stored as received right away.
- **Malformed fields are left out, not fatal.** Symbolicator refuses a whole request when one field has the wrong shape, and events come from anyone holding the DSN. Sentinel forwards only well-formed addresses, names and line numbers; the frames it leaves out stay as they were.
- **Grouping follows the real code.** Issues are grouped by the symbolicated frames. An issue first seen without its dSYM is not split when the file arrives: reprocessing (below) points the new grouping at the same issue.
- **Missing files are flagged.** A crash whose app image (iOS) or mapping (Android) has no stored file gets a **dSYM missing** / **Mapping missing** tag in the issue list and on the issue, plus a warning on its stack trace. The tag opens Project settings → Debug files on the right platform tab, naming the file. That page has one tab per platform, each with how to get the file (Xcode archive, R8 `mapping.txt` and its UUID), the upload and the stored files. System libraries never need a dSYM and are not flagged.
- **Uploading reprocesses.** When a dSYM or mapping is stored (dashboard, API, sentry-cli or MCP), every issue that was waiting for it is reprocessed in the background: its 20 newest events are symbolicated again from the frames the SDK sent, and the issue's title and culprit follow (an Android `b: boom` becomes `BoomException: boom`). Reprocessed events carry `symbolication_reprocessed: yes`; the upload answer says how many issues were queued (`reprocessing`).
- **Events with no stored files** skip the queue and are stored immediately, as before.
- **Budget per project.** A project symbolicates at most 500 crashes per hour by default; past that, crashes are stored right away with their raw frames, tagged `symbolication:skipped`. Owners and admins change it with `PATCH /api/projects/:slug {"maxSymbolicationsPerHour": n}` (or the MCP tool `update_project`, `max_symbolications_per_hour`); `0` turns symbolication off. `GET /api/projects/:slug/settings` shows the limit and this hour's count.
- **Cache.** The same crash from many devices is symbolicated once: answers are kept for 24 hours per project, keyed by the crash with its addresses made relative to each image (ASLR moves the absolute ones), and by the debug files stored at the time, so uploading or deleting a file never reuses an old answer. Events answered from it carry `symbolication_cache:hit`.
- **Backpressure.** At most 4 symbolications run at once across all projects, and a crash that waited more than 10 minutes in the queue (after a crash storm) is stored as received, tagged `symbolication:skipped` with `symbolication_reason:backlog`. Budget refusals carry `symbolication_reason:budget` (or `disabled`).
- **New iOS and Android projects start with an event quota** of 5000 events per hour (the DSN and debug ids ship inside the app, so anyone can send crashes). Set `maxEventsPerHour` to `0` for unlimited.
- An event only waits in the queue when its project would accept it right now: over the hourly quota or being deleted, the SDK gets `429`/`503` as before. The quota is checked again when the event is stored, and an event whose project was deleted while it waited is dropped.
- Local `wrangler dev` (and CI) do not build the container (`dev.enable_containers: false` in `wrangler.jsonc`, plus `--var SYMBOLICATION:off` in `just dev-up` and the integration suite). To try it locally, run `wrangler dev` with a copy of the config where `enable_containers` is `true`, with Docker running.

### What you need

1. **An API token with the `write` scope**: dashboard → **Settings → API tokens**. Store it as a secret named `SENTINEL_AUTH_TOKEN` (GitHub: *Settings → Secrets and variables → Actions*). Never commit it or ship it in an app.
2. **Your project slug** (the URL segment in the dashboard, e.g. `my-app`) and your Sentinel URL.
3. **[sentry-cli](https://docs.sentry.io/cli/installation/)** for folders and big files (`brew install getsentry/tools/sentry-cli`, or `npx @sentry/cli` anywhere Node runs). Tested with **3.8.2**. `curl` is enough for single files up to 95 MB.

sentry-cli only needs four variables — Sentinel accepts any organization slug, `sentinel` by convention:

```bash
export SENTRY_URL=https://your-sentinel.example.com
export SENTRY_ORG=sentinel
export SENTRY_PROJECT=my-app
export SENTRY_AUTH_TOKEN=$SENTINEL_AUTH_TOKEN
sentry-cli info   # shows your user and the token's scopes
```

On a build machine you can keep the token in `~/.sentryclirc` (`[auth]` → `token=wst_…`) and the rest in a `.sentryclirc` committed with the project (`[defaults]` → `url=`, `org=`, `project=`); sentry-cli merges both.

Behind Cloudflare Access (like the lab instance), CI and agents only use `/api/0/*` and `/mcp`, which are reachable without an Access login and authenticate with the token.

### iOS: dSYMs

```bash
# A whole archive (each architecture is stored under its own UUID):
sentry-cli debug-files upload --wait MyApp.xcarchive/dSYMs

# One file with curl (gzip is optional):
gzip -c MyApp.app.dSYM/Contents/Resources/DWARF/MyApp | curl --fail-with-body -X POST \
  "$SENTRY_URL/api/0/projects/sentinel/my-app/debug-files/?name=MyApp" \
  -H "Authorization: Bearer $SENTINEL_AUTH_TOKEN" -H "Content-Encoding: gzip" --data-binary @-
```

`dwarfdump --uuid MyApp.app.dSYM` prints the UUIDs a crash's `debug_meta` must match. Uploading the app binary instead of the dSYM is refused with a message saying so. The build needs `DEBUG_INFORMATION_FORMAT = dwarf-with-dsym` (the Release default).

**GitHub Actions** (macOS runner):

```yaml
- name: Archive
  run: |
    xcodebuild archive -scheme MyApp -configuration Release \
      -destination "generic/platform=iOS" -archivePath "$RUNNER_TEMP/MyApp.xcarchive" \
      DEBUG_INFORMATION_FORMAT=dwarf-with-dsym
- name: Upload dSYMs to Sentinel
  env:
    SENTRY_URL: https://your-sentinel.example.com
    SENTRY_ORG: sentinel
    SENTRY_PROJECT: my-app
    SENTRY_AUTH_TOKEN: ${{ secrets.SENTINEL_AUTH_TOKEN }}
  run: npx --yes @sentry/cli debug-files upload --wait "$RUNNER_TEMP/MyApp.xcarchive/dSYMs"
```

**Xcode build phase** (uploads on every Release build; not yet run in Xcode against Sentinel): *Build Phases → + → New Run Script Phase*, after *Embed Frameworks*, with Input File `${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}` and `ENABLE_USER_SCRIPT_SANDBOXING = NO`. The token comes from `~/.sentryclirc`.

```bash
if [ "$CONFIGURATION" != "Release" ]; then exit 0; fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v sentry-cli >/dev/null; then
  echo "warning: sentry-cli not installed (brew install getsentry/tools/sentry-cli)"; exit 0
fi
export SENTRY_URL="https://your-sentinel.example.com" SENTRY_ORG="sentinel" SENTRY_PROJECT="my-app"
sentry-cli debug-files upload "$DWARF_DSYM_FOLDER_PATH" || echo "warning: dSYM upload to Sentinel failed"
```

### Android: R8/ProGuard mapping

A mapping is matched by a UUID the app itself reports. The [Sentry Android Gradle plugin](https://docs.sentry.io/platforms/android/configuration/gradle/) generates it, embeds it in the APK/AAB and uploads `mapping.txt` with it over the sentry-cli protocol Sentinel speaks (the plugin itself has not been run against Sentinel yet; the protocol has, with sentry-cli):

```kotlin
// app/build.gradle.kts
plugins {
  id("io.sentry.android.gradle") version "<latest>"
}

sentry {
  url.set("https://your-sentinel.example.com")
  org.set("sentinel")
  projectName.set("my-app")
  authToken.set(System.getenv("SENTINEL_AUTH_TOKEN"))
  includeProguardMapping.set(true)
  autoUploadProguardMapping.set(true)
  includeSourceContext.set(false)
  telemetry.set(false) // otherwise the plugin reports build telemetry to sentry.io
}
```

```yaml
# GitHub Actions
- name: Build release (uploads the R8 mapping)
  env:
    SENTINEL_AUTH_TOKEN: ${{ secrets.SENTINEL_AUTH_TOKEN }}
  run: ./gradlew assembleRelease
```

Without the plugin: `sentry-cli upload-proguard --uuid <uuid> app/build/outputs/mapping/release/mapping.txt`, or `curl … "$SENTRY_URL/api/0/projects/sentinel/my-app/debug-files/?kind=proguard&debugId=<uuid>" --data-binary @mapping.txt`. Without a UUID, Sentinel derives the same content-based UUID sentry-cli does; the app must report that UUID for the match.

### Agents: MCP and Claude in Xcode

The [Sentinel MCP](#mcp-ai-agents) has the whole flow:

| Tool / prompt | What it does |
|---|---|
| `get_debug_file_upload` | sentry-cli variables, Xcode build phase, GitHub Actions steps, Gradle config and curl commands for a project, filled in (token always `$SENTINEL_AUTH_TOKEN`) |
| `check_debug_files` | For an issue (its latest event), an event or a list of UUIDs: which debug files are `found`, `missing` or `processing` |
| `list_debug_files` | What is stored, with storage used |
| `upload_debug_file` | Uploads one small file (≤ 8 MB) given as base64 |
| `delete_debug_file` | Deletes one (owners/admins; repeat the id to confirm) |
| prompt `upload_debug_files` | Walks the agent through finding the dSYMs/mapping in the workspace, uploading, confirming and (if you want) automating it |

Claude Code: `claude mcp add --transport http sentinel https://your-sentinel.example.com/mcp --header "Authorization: Bearer $SENTINEL_AUTH_TOKEN"`, then ask it to *"upload the dSYMs of this app to Sentinel"* (or run the `upload_debug_files` prompt).

Claude in Xcode: Xcode keeps the agent's MCP servers in `~/Library/Developer/Xcode/CodingAssistant/mcp-servers.json`, in the usual `mcpServers` format — add the same entry as for other clients (`"sentinel": {"type": "http", "url": "https://your-sentinel.example.com/mcp", "headers": {"Authorization": "Bearer wst_…"}}`) and restart Xcode. (The file location comes from Xcode itself; the connection has not been tested from Xcode yet.)

### API

The same operations at two paths with the same token: `/api/0/projects/{org}/{project}/debug-files/…` for CI (works behind Cloudflare Access) and `/api/projects/{slug}/debug-files…` for the dashboard.

| Method and path | Purpose |
|---|---|
| `POST …/debug-files/?name=&kind=dsym\|proguard&debugId=` | Upload one file as the raw body (≤ 95 MB, `Content-Encoding: gzip` allowed) → `201 {debugFiles: […]}` |
| `GET …/debug-files/?kind=&debugId=&cursor=` | List (newest first, keyset pages) with `usage` |
| `POST …/debug-files/check/` `{issueId}` \| `{eventId}` \| `{debugIds: […]}` | `images[]` with `found` / `missing` / `processing` and counts |
| `GET`/`DELETE …/debug-files/{id}/` | One file; delete needs project owner/admin |
| `GET`/`POST /api/0/organizations/{org}/chunk-upload/`, `POST /api/0/projects/{org}/{project}/files/difs/assemble/`, `GET`/`DELETE …/files/dsyms/` | The sentry-cli protocol (8 MB chunks, up to 2 GB per file) |

Limits: 5 GB of debug files per project; a re-upload of the same UUID replaces it; universal dSYMs are split per architecture; upload chunks expire after a day. Through sentry-cli, an app binary uploaded next to its dSYM (Xcode's products folder) is acknowledged but not stored; the direct API refuses it.

## Webhook Notifications

Workers Sentinel can send a POST request to any HTTP endpoint when a new issue is detected. This enables integration with Slack, Discord, PagerDuty, or any custom alerting system.

### Setup

1. Go to **Project Settings** in the dashboard
2. Enter your webhook URL in the **Webhook Notifications** section
3. Click **Save**
4. Use **Send Test** to verify the endpoint receives notifications

Webhook URLs must use HTTPS.

### Payload Format

When a new issue is detected, Workers Sentinel sends a JSON POST request:

```json
{
  "text": "[My App] New error: TypeError: Cannot read property 'foo' of undefined in app.js",
  "project": {
    "id": "project-uuid",
    "name": "My App",
    "slug": "my-app"
  },
  "issue": {
    "id": "issue-uuid",
    "title": "TypeError: Cannot read property 'foo' of undefined",
    "level": "error",
    "culprit": "app.js"
  },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

The `text` field is formatted for direct use with Slack Incoming Webhooks. For Discord, use the same URL format with `/slack` appended to your Discord webhook URL.

### Notes

- Webhooks fire only for **new** issues (first occurrence of a unique error fingerprint)
- Delivery is best-effort — failures are logged but not retried
- Webhook requests are sent asynchronously and never slow down event ingestion

## Managing Team Members

Workers Sentinel supports sharing projects with other registered users through role-based access control.

### Roles

- **Owner** — Full access to the project; the only one who can delete it. Cannot be removed or changed.
- **Admin** — Updates project settings (webhook, rate limit, retention, filters, name, platform), rotates the DSN key, and deletes issues and source maps.
- **Member** — Views the project, its issues and events; triages issues (resolve, ignore, snooze, merge), comments, and uploads source maps. Cannot delete issues or source maps.

Project membership itself is managed by instance administrators in the admin area. API tokens and the MCP act with the token owner's role, narrowed by the token's scopes.

### Adding Members

1. Go to **Project Settings** in the dashboard
2. Scroll to the **Team Members** section
3. Enter the user's email address and select a role
4. Click **Add**

Users must register an account before they can be added to a project. There is no invitation system — members are added by their registered email address.

## API Tokens

API tokens allow programmatic access to the Workers Sentinel API — useful for CI/CD pipelines, scripts, custom dashboards, and integrations with incident management tools.

### Creating a Token

1. Go to **Project Settings** in the dashboard
2. Click **Manage API Tokens** in the API Tokens section
3. Enter a token name (e.g., `ci-pipeline`), pick its **access** and an optional expiration date
4. Click **Create Token**
5. **Copy the token immediately** — it will only be shown once

### Using a Token

Include the token in the `Authorization` header of any API request:

```bash
# List projects
curl -H "Authorization: Bearer wst_your_token_here" \
  https://your-sentinel.workers.dev/api/projects

# Get issues for a project
curl -H "Authorization: Bearer wst_your_token_here" \
  https://your-sentinel.workers.dev/api/projects/my-app/issues

# List events for an issue
curl -H "Authorization: Bearer wst_your_token_here" \
  https://your-sentinel.workers.dev/api/projects/my-app/issues/issue-uuid/events
```

API tokens use the `wst_` prefix and work alongside existing session-based authentication.

### Scopes (access)

| Access | Scope | Can do |
|---|---|---|
| Read only | `read` | Read projects (with their DSN), issues, events and attachments |
| Read & write (default) | `write` | Also triage issues, add notes and edit project settings |
| Projects | `projects` | Also create projects, rotate DSN keys and delete projects — what an AI agent needs to connect your apps end to end. Only an admin signed in with a passkey can create such a token |

A token without the needed scope gets `403 {"error": "insufficient_scope", "required": "…"}`. Tokens created before scopes existed are Read & write.

```bash
# With a "projects" token: create a project and get its DSN
curl -X POST -H "Authorization: Bearer wst_…" -H "Content-Type: application/json" \
  -d '{"name": "My API", "platform": "cloudflare-workers"}' \
  https://your-sentinel.workers.dev/api/projects

# Rotate its DSN key (the old key stops working at once)
curl -X POST -H "Authorization: Bearer wst_…" \
  https://your-sentinel.workers.dev/api/projects/my-api/rotate-key
```

### Token Management

- **Expiration**: Tokens can be created with an optional expiration date. Expired tokens are automatically rejected.
- **Revocation**: Revoke tokens from the API Tokens dashboard page. Revoked tokens stop working immediately.
- **Limits**: Each user can have up to 10 active API tokens.
- **Audit**: Each token's Last Used timestamp is updated on each successful request.

### Security Best Practices

- Store tokens in environment variables, never in source code
- Use descriptive names so you can identify which token belongs to which service
- Set expiration dates for tokens used in temporary or rotating access scenarios
- Revoke tokens immediately when they are no longer needed or may be compromised
- Token management (creating, listing, revoking) requires session authentication — a compromised API token cannot create new tokens
- Give each token the least access it needs; keep "Projects" tokens for the agent or script that actually sets projects up

## Architecture

Workers Sentinel is built with modern web technologies:

**Backend (Worker):**
- **Hono** - Fast, lightweight web framework
- **Cloudflare Durable Objects** - Distributed state with SQLite storage
- **Sentry Envelope Parser** - Compatible with Sentry SDK wire format

**Frontend (Dashboard):**
- **Vue.js 3** - Progressive JavaScript framework
- **TypeScript** - Type-safe development
- **Tailwind CSS** - Utility-first styling
- **Pinia** - State management
- **Vite** - Fast build tooling

**Data Architecture:**
- **AuthState DO** (singleton) - Users, sessions, project registry
- **ProjectState DO** (per-project) - Issues, events, statistics

Each project has its own isolated Durable Object with SQLite storage, ensuring data isolation and scalability.

**Rate Limiting:**
- Per-project configurable hourly event quotas stored in the ProjectState DO
- In-memory counter with persistent backup in SQLite for fast O(1) checks
- Returns HTTP 429 with `Retry-After` header when quota is exceeded — Sentry SDKs handle this gracefully
- Default is unlimited (0); configurable via dashboard or `PATCH /api/projects/:slug`

## Roadmap & Future Enhancements

Planned features for future releases:

- [x] Source map support for JavaScript errors
- [x] Debug file uploads (dSYM, R8/ProGuard) via sentry-cli, API and MCP
- [x] Native symbolication and deobfuscation with those files (Symbolicator in a Cloudflare Container)
- [ ] Release tracking and deployment correlation
- [ ] Performance monitoring (transactions, spans)
- [x] Webhook alerting notifications
- [ ] Email alerting notifications
- [ ] Session replay support
- [x] Team/organization support
- [ ] Issue assignment
- [x] Tag-based search and filtering
- [x] Time-series charts
- [x] Rate limiting per project
- [x] Event retention policies

## Known Limitations

**Current Limitations:**
- No performance monitoring (error tracking only)
- Email notifications not yet available (webhooks supported)
- No project ownership transfer (creator remains permanent owner)

**Sentry Feature Parity:**
Workers Sentinel focuses on core error tracking. Advanced Sentry features like:
- Session replay
- Performance monitoring
- Profiling
- Crons monitoring

Are not currently supported but may be added in future versions.

**Browser Compatibility:**
- Modern browsers required (Chrome 90+, Firefox 88+, Safari 14+)
- JavaScript must be enabled
- Cookies must be enabled for authentication

## Contributing

We welcome contributions from the community!

**🐛 Bug Reports**
- Use the [GitHub Issues](https://github.com/G4brym/workers-sentinel/issues) page
- Include reproduction steps
- Specify your environment

**✨ Feature Requests**
- Check existing issues first
- Explain the use case and benefit

**💻 Code Contributions**
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a Pull Request

**Development Setup:**
```bash
# Clone and install
git clone https://github.com/G4brym/workers-sentinel.git
cd workers-sentinel
pnpm install

# Start development (runs wrangler dev)
pnpm dev

# Build dashboard
pnpm --filter @workers-sentinel/dashboard build

# Typecheck
pnpm typecheck

# Lint
pnpm lint
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

**Made with ❤️ for the self-hosted community**

If you find Workers Sentinel useful, please consider giving it a ⭐ on GitHub!
