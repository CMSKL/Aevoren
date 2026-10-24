<div align="center">

<img src="resources/icon.png" alt="Aevoren icon" width="96">

# Aevoren

**AI contacts you can keep working with.**

Chat with persistent Bots, bring them together in groups, organize documents and Skills, and give AI an isolated computer or a specific Mac window or browser tab to work with.

[简体中文](README.zh-CN.md) · English

[![Version](https://img.shields.io/badge/version-v0.1.0-2563eb)](https://github.com/CMSKL/Aevoren/releases) [![Beta CI](https://github.com/CMSKL/Aevoren/actions/workflows/ci.yml/badge.svg?branch=beta)](https://github.com/CMSKL/Aevoren/actions/workflows/ci.yml?query=branch%3Abeta) [![License](https://img.shields.io/badge/license-Apache--2.0-16a34a)](LICENSE)

[Main interface](#main-chat-interface) · [Computer use](#give-ai-a-computer-to-work-in) · [Download](#download) · [Get started](#get-started) · [Screenshots](#screenshots) · [Features](#features) · [Develop from source](#develop-from-source) · [Project resources](#project-resources)

</div>

## Main chat interface

![Aevoren main chat interface with conversations, messages and composer](assets/screenshots/main-chat.png)

<p align="center"><sub>The v0.3.0-beta.42 main chat interface: conversation list, ongoing discussion and message composer. Dialogue is prewritten sample content.</sub></p>

Aevoren is a **local-first desktop workspace for AI conversations and collaboration**. Each Bot has its own role, model and ongoing conversations. Groups bring several Bots into the same task, while documents, reviewed Memory, permissions and execution records stay organized around the conversation. Connect an OpenAI-compatible API, Claude Code or Codex CLI, and choose a separate execution model for computer tasks.

Local-first means that conversation history and application state live on your computer. Model calls, web access and external app connections still send relevant content to the selected services; see [Data and permissions](#data-and-permissions).

## Give AI a computer to work in

Give a Bot a goal and choose where it works. Its **built-in Linux computer** can browse, run code and manage files in an isolated workspace. On your Mac, you can separately authorize a **specific background application window or shared browser tab**. Inspect the actual screen and results, take over when needed, and explicitly hand control back.

![Aevoren isolated computer workspace with a live browser screen](assets/screenshots/computer-workspace.png)

<p align="center"><sub>A running isolated computer and browser displaying a local demonstration page. See the screenshot record for the capture method and recorded actions.</sub></p>

| Computer target | Available work | Setup and boundary |
| --- | --- | --- |
| **Bot’s built-in computer** | Browser and desktop input, Shell / Python / Node, Linux apps and persistent files | Local Docker Linux engine; separate workspace and profile for each chat and executing Bot |
| **Shared browser tab on this Mac** | Background screenshots, clicks, typing, text reading and navigation with the tab’s existing login | Manually load and pair the bundled extension, then share a specific tab; no cookie copying or visible-tab switching |
| **Application window on this Mac** | Background actions on accessible buttons, text fields and select-all | Explicitly select a window; Screen Recording and Accessibility permissions required; window capture needs macOS 14+ |

Bot and group details have one **Computer** entry. **Settings → Computer** manages **Your computer** and **Bot’s computer**; **Settings → Models** selects the independent computer execution model. **My turn** pauses AI access, and **Hand to AI** explicitly returns control. The [computer target details](#2-computer-targets-browsers-and-execution) below describe setup and limits. The Linux screenshot shows a real browser operated by the capture process, without an AI model call.

## Version and availability

The first release in this repository is being prepared as **v0.1.0**, using the current code. Subsequent releases follow Semantic Versioning, starting with `0.1.1` for fixes and `0.2.0` for new functionality. Published installers, signing and validation details will appear in [Releases](https://github.com/CMSKL/Aevoren/releases). Development continues on `dev`; validated changes are promoted through `beta` to `master`.

The original marketing scenario remains **partially completed**. A model that does not write the requested files is not counted as successful; Pro model comparison is deferred. Six parallel replies do not establish capacity for six simultaneous desktops. Parent 16-round and computer 100-action/30-minute limits remain unchanged.

| What you want to do | Start here |
| --- | --- |
| Install and use the app | Check [Releases](https://github.com/CMSKL/Aevoren/releases) for the first v0.1.0 installer, then follow the setup steps below |
| Explore the product | Browse the screenshots, [feature guide](#features) and [setup steps](#get-started) |
| Work on the source | Work directly on `dev` and follow [Develop from source](#develop-from-source) |
| Review testing, signing and upgrade evidence | Read the [release notes](https://github.com/CMSKL/Aevoren/releases) and [Beta CI results](https://github.com/CMSKL/Aevoren/actions/workflows/ci.yml?query=branch%3Abeta) |

> Aevoren is under active development. This repository's first installer release is pending. Background browser and standard AppKit controls have controlled test coverage. This does not promise compatibility with every Mac app or complete background tasks through every model. Third-party account operations, Windows Docker and actual automatic-update installation retain separate validation boundaries.

## Download

| Platform | Download and status |
| --- | --- |
| **macOS 13+ · Apple silicon** | v0.1.0 DMG pending. Published installers and SHA-256 checksums will appear in [Releases](https://github.com/CMSKL/Aevoren/releases). The release workflow requires Developer ID signing and Apple notarization |
| **Windows 10/11 · x64** | [Beta CI installer downloads](https://github.com/CMSKL/Aevoren/actions/workflows/ci.yml?query=branch%3Abeta). Choose a successful run for the current package version and its unsigned x64 installer artifact. GitHub sign-in is required; retention is 30 days. No Windows automatic-update feed is published |
| Intel macOS / Linux desktop | Not currently tested or released |
| iOS / Android | Not implemented |

Compare the download with the SHA-256 checksum file in the release or validation archive. On macOS, open the DMG and move the app to Applications. On Windows, extract the validation archive and run its NSIS installer. Official macOS packages can check for updates under **Account menu → Settings → Version updates**.

Ordinary conversations and authorized Mac targets do not require Docker. The **built-in Linux computer** and script execution need a running local Docker Linux engine; supported Colima setups also work without Docker Desktop. Application-window screenshots require **macOS 14+**, while the app itself retains macOS 13+ support. See [Get started](#get-started) and [computer target details](#2-computer-targets-browsers-and-execution) for setup, permissions and boundaries.

## Get started

1. **Configure a model connection.** Click the bottom-left account avatar and open **Settings → Models**. Configure an API connection, or check the installation and authentication of your local Claude Code / Codex CLI.
2. **Create a Bot.** Give it a name, role and working instructions. In its details, open **More → Models & capabilities** to choose a source and model. Shared connections still allow each Bot to use a different model.
3. **Start a conversation.** Describe a task. Use **＋** beside the composer to add attachments, media, document references or Skills. Search Bots and groups with `Cmd/Ctrl + K`.
4. **Choose resources and a computer target.** Bind documents in Library and select a workspace folder when needed. Open **Settings → Computer** to choose the built-in Linux computer or explicitly enable and select a Mac window/shared tab, then open the conversation’s **Computer** view.
5. **Inspect the results.** Task details show tool output, delivery files and failures. Choose **My turn (我来操作)** to pause AI access to the selected computer; choose **Hand to AI (交给 AI)** when you are ready to return control.

### Choose a model source

| Source | What you need | How it connects |
| --- | --- | --- |
| OpenAI-compatible API | Base URL, API Key and an available model | Discover models and test a real request in Settings, then select a model for the Bot |
| Claude Code | A local installation with valid authentication | Discover the CLI, authentication and models automatically; available capabilities depend on the CLI and authentication configuration |
| Codex CLI | A local installation with valid authentication | Discover models and use the app's tools through App Server Dynamic Tools |

**Settings → Models → Computer execution model** selects a separate source for computer tasks. Its image/tool probe tests the actual selected configuration. Screenshot transport does not establish reliable visual understanding for every model. When a CLI uses a third-party route, that route determines the model actually serving the request.

## Screenshots

These images were captured from the actual beta.42 Electron interface using separate local sample data and prewritten conversations. They were captured on October 21, 2026 from source commit `629b9bf618c77b0388739d81bedfdb1f0c02f2ab`, using native Electron capture. The computer image follows real navigation, clicks, typing and file readback driven by the capture process, without an AI model call. Detailed capture and cleanup receipts remain local.

### Group collaboration

Bring research, writing and review roles into one conversation. Address a specific member, ask everyone for independent replies, or let a coordinator arrange work with dependencies.

![Multi-Bot group chat with example contributions from different roles](assets/screenshots/group-collaboration.png)

### Documents and fixed references

Edit and preview documents, restore earlier versions, and share documents or Skills with selected conversations. Sent references retain the version used at the time.

![Sample document in the Library](assets/screenshots/library-and-skills.png)

<details>
<summary>View a reusable Skill</summary>

![Reusable text Skill](assets/screenshots/skills.png)

<p><sub>A sample text Skill. Loading its instructions and granting tool execution permissions are separate actions.</sub></p>

</details>

## Features

### 1. Persistent Bots and group collaboration

Each Bot keeps its identity, working instructions, model selection and ongoing conversations. Chats tracks recent conversations and unread replies; Contacts manages Bots. Removing a chat, clearing its history and deleting a contact are separate operations.

Groups support **2–6 members** with three main collaboration modes:

| Mode | Useful for | Behavior |
| --- | --- | --- |
| `@Bot` | A question for one particular role | The selected member replies independently |
| **Everyone** (`@所有人`) | Multiple perspectives or parallel research | All members start concurrently and stream their own replies; one member's failure or wait does not block the others |
| Fixed coordinator | Research, then writing, then review | Assigns work in dependency order and summarizes the results |

Stop an entire group batch or retry an individual failed member. Joining a group does not automatically share a member's private documents, Memory or folder permissions. A model saying “done” does not count as successful tool execution; content-team Brief decisions, failure recovery and delivery status have their own interface states.

### 2. Computer targets, browsers and execution

**Built-in Linux computer.** Each conversation and executing member has its own Docker Linux environment, persistent workspace and Chromium profile. With this target selected, opening **Computer** prepares it and shows progress or an actionable Docker/Colima error. The following capabilities belong to this isolated environment:

- **Browser and desktop:** navigate, observe, capture screenshots, click, type, use key combinations and drag continuously, with a fresh real frame after an action.
- **Commands and services:** run Shell, Node or Python, inspect actual stdout/stderr and exit codes, cancel tasks, manage background processes and preview registered services.
- **Persistent tasks:** tasks on one computer queue in order; different computers can work in parallel. Each segment pauses at 100 actions or 30 minutes and retains its checkpoint.
- **Linux applications:** install verified distribution packages, `.deb`, AppImage or a single executable. Windows and macOS native applications are not supported.
- **Human takeover:** **My turn** pauses AI observation and input. Disconnecting does not return control; an explicit handback requires the AI to observe again.
- **Files and previews:** downloads contain verified bytes. A preview stays bound to its registered service process; a different process reusing its port does not inherit access.

**This Mac: background application windows.** Enable access under **Settings → Computer → Your computer**, then select and save a window. The helper uses public Accessibility actions on identifiable buttons and editable text fields, with select-all support. Window capture needs macOS 14+, Screen Recording and Accessibility permissions. It does not move the global pointer, activate apps or bring windows forward. Generic native drag, scroll and other shortcuts are not exposed; unsupported controls stop with an explicit error, with no foreground fallback.

**This Mac: shared browser tabs.** Load the bundled extension manually in a compatible Chromium browser, pair it with Aevoren and explicitly share the target tab. The connection supports real screenshots, clicks, typing, text reading and HTTP(S) navigation while retaining that tab’s existing login. It does not copy cookies, change the visible tab or restart the browser. Closing or unsharing the tab stops access; native file pickers and browser permission dialogs remain unsupported.

All Mac tasks share one queue and the explicitly selected target. Their app data and existing browser login are **not isolated per chat**. Changing targets pauses old tasks and invalidates old observations; takeover or revocation invalidates prior access. Restarting the app restores human ownership. Use the built-in computer for separate member profiles and parallel environments.

The built-in environment does not mount host HOME, Docker socket or personal browser profiles. No general host Shell, remote Linux or Windows host GUI control is provided. Both isolated web work and authorized Mac actions can affect external services; takeover cannot undo an action already delivered.

### 3. Library, images and documents

Create, import and bind resources in **Library** within Bot or group details. Markdown documents support editing, preview, search, export, version recovery and enable/disable controls. Select a document through the composer's `@` picker to pin its resource version and digest; later edits do not replace the content already referenced in a message.

| Media type | Per-file limit | Current support |
| --- | --- | --- |
| PNG / JPEG | 2 MiB, 16 million pixels | Image preview and actual pixel transport |
| PDF | 16 MiB, 200 pages | Extracted text, page offsets and bounded page-image previews |
| DOCX | 8 MiB | Extracted text and section offsets; original layout fidelity is not guaranteed |

An import accepts up to six files and 32 MiB total; extracted text also has a size limit. Imported originals are saved in application-owned storage, so moving the source files does not break them. Removing a resource from one conversation revokes that binding; resource deletion has separate version and recovery controls.

OCR, encrypted PDFs, audio/video processing and voice are outside the current scope. Image transport and the selected model's visual capabilities are verified separately.

### 4. Text Skills, script Skills and human demonstrations

Skills save reusable working methods inside the app. Create a text Skill, or import a directory containing `SKILL.md`, references, scripts and assets. Select `/Skill` or a Skill from the `@` picker to use a fixed version in a message. Adding a Skill prepares the draft; sending the message starts the task.

Scripts support **Bash, Python and Node**. An initial grant fixes the conversation, executing Bot, Skill revision, script entry and environment image. Runs covered by that exact grant use a recorded argument snapshot without repeated routine approval. New revisions, revoked grants, disabled Skills or environment changes trigger the relevant checks. Output and exit status come from the actual isolated environment.

Human demonstrations start only through an explicit user action. They record sanitized interaction information from the isolated computer and produce an editable draft. Reviewing and publishing creates an **initially disabled text Skill**. It neither grants script permissions nor creates an automatically replayed macro.

### 5. MCP, app connections and external drafts

**MCP** supports stdio, Streamable HTTP, OAuth 2.1/PKCE and interactive MCP Apps with scoped permissions. Tools are granted to a Bot and conversation; a third-party server's `readOnlyHint` is not automatically trusted.

Configure Gmail, Drive and Notion under **Settings → App connections**. Connecting an account and authorizing a Bot are separate steps: a connected account does not make all its content available to every Bot.

| Connection | Reads and drafts | Separately authorized writes |
| --- | --- | --- |
| Gmail | Search messages, read bounded text and save local drafts | Send a fixed approved message draft; attachments and BCC are not included |
| Google Drive | Select authorized files and read supported content | Create or replace ordinary text files; native Docs/Sheets/Slides creation or conversion is not included |
| Notion | Search page titles and read bounded page content | Create a page, update its title only, or append paragraphs at the end |

External writes require a specific **account, operation and target grant plus approval of a fixed draft**. Unknown results must be checked rather than sent again automatically. Implementation and controlled tests are available; genuine Google/Notion authorization and reads/writes still require validation with the particular account.

### 6. Memory, workspaces and Routines

- **Long-term Memory:** User, Bot and Workspace scopes. Background capture proposes pending candidates; only accepted entries enter long-term context.
- **Local workspaces:** folder permissions belong to the conversation. Authorized tools can list, read and search files. Host writes are limited to new UTF-8 Markdown/CSV files inside explicitly writable roots and cannot overwrite existing files.
- **Routines:** one-time, interval or cron schedules, with execution history, notifications and background window behavior. macOS also supports optional login startup.
- **Conversation recovery:** SQLite transcripts, the Send Journal, stable request identities and tool records support streaming, cancellation, idempotent retry and crash recovery.

New ordinary chats start without a local folder. Manage folders, projects and archived chats under **Settings → Capabilities and permissions → Local files and chat management**. Clearing chat history preserves contacts, accepted Memory and actual files.

### 7. Product actions available to AI

Models discover and use app actions through `product_catalog → product_describe → product_execute`. These cover Bot/group management, delegation, documents, Skills, Memory, workspaces, Routines, computers and app connections. The interface and AI share the same host validation and permission rules.

Routine internal operations and authorized computer work run directly. New permissions, high-impact operations and private reads retain their relevant confirmation steps. Unsent draft reads and edits are bound to the calling task's conversation; switching the visible chat does not give that task access to another chat's draft.

## Data and permissions

| Data or operation | Storage and boundary |
| --- | --- |
| Bots, groups, conversations, Memory, settings and task records | SQLite in Electron's local user-data directory |
| API Keys / OAuth credentials | Encrypted with Electron `safeStorage`; saved secret values are not returned to the interface or model |
| Imported documents and Skill files | Application-owned storage with digest checks; access follows conversation bindings and current authorization |
| Isolated computer and browser data | Workspace, runtime state and browser profile in separate Docker volumes |
| Authorized Mac windows and shared tabs | Real application data and existing browser login on this Mac; access is restricted to the selected target, with no per-chat data isolation |
| Model and external service requests | Authorized context, tool inputs or images needed for the task; data handling depends on the selected service |

The Renderer uses sandboxing and Context Isolation. Preload exposes only typed, validated capabilities. Public web reads reject private-network targets, unsafe schemes, dangerous redirects and oversized responses. Web, MCP, CLI and model responses are treated as untrusted input.

Permissions do not provide semantic detection of every external side effect. Native external writes and writable MCP actions have dedicated approvals; isolated browser clicks, Docker commands or authorized Mac actions can still change remote services, and not every such action is guaranteed to show a confirmation.

There is currently no cloud sync, multi-user account system or billing. Back up data or use an isolated directory before testing prereleases; encrypted credentials cannot simply be moved across operating systems. Remove secrets, private conversations and databases from issue reports. Report security concerns privately through the repository's [security advisory page](https://github.com/CMSKL/Aevoren/security/advisories/new).

## Develop from source

Install Git, **Node.js 24+** and **pnpm 11.19.0**. macOS requires Xcode Command Line Tools; use PowerShell on Windows. Built-in Linux computer and script features also need a local Docker Linux-container runtime; the separate Mac targets use the permissions and pairing described above.

```bash
git clone --branch dev https://github.com/CMSKL/Aevoren.git
cd Aevoren-Bot
pnpm install --frozen-lockfile
pnpm dev
```

`dev` is the development branch and may be ahead of the release described here. Configure a real model in Settings after launching. Use a dedicated data directory during development to keep daily-use conversations separate:

```bash
# macOS / zsh / bash: replace with a dedicated absolute path
AEVOREN_BOT_USER_DATA_DIR=/absolute/path/to/aevoren-dev-data pnpm dev
```

```powershell
# Windows PowerShell
$env:AEVOREN_BOT_USER_DATA_DIR = "$env:LOCALAPPDATA\Aevoren-Bot-Dev"
pnpm dev
```

<details>
<summary>Explore the interface without configuring an account</summary>

The Fake Provider returns deterministic test content without calling a real model. It does not demonstrate real model or tool execution capabilities.

```bash
AEVOREN_BOT_FAKE_PROVIDER=1 AEVOREN_BOT_USER_DATA_DIR=/absolute/path/to/aevoren-demo-data pnpm dev
```

```powershell
$env:AEVOREN_BOT_FAKE_PROVIDER = "1"
$env:AEVOREN_BOT_USER_DATA_DIR = "$env:LOCALAPPDATA\Aevoren-Bot-Demo"
pnpm dev
# Remove the flag before starting a real-model session
Remove-Item Env:AEVOREN_BOT_FAKE_PROVIDER
```

</details>

### Common commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Build the Mac helper on macOS and the media parser, then start the Electron development app |
| `pnpm typecheck` / `pnpm lint` | Type checking / ESLint |
| `pnpm test` | Run Vitest tests |
| `pnpm build` | Type-check and build the app, Mac helper on macOS, both Workers and the media parser |
| `pnpm test:smoke` | Build, then run Electron Playwright smoke tests |
| `pnpm docs:check` | Check local Markdown links |
| `pnpm licenses:check` / `pnpm security:audit` | Check dependency licenses / run the security audit |
| `pnpm verify` | Types, lint, tests, build, licenses and documentation; excludes smoke tests and the security audit |
| `pnpm package:mac` | Create a local macOS arm64 directory package |
| `pnpm package:win` / `pnpm package:win:dir` | Create a Windows x64 NSIS installer / unpacked directory |

Electron smoke tests use hidden windows and isolated user data. A local package is not the same as an official signed, notarized release.

### Project layout

```text
src/main/          Electron main process, database, models, permissions and services
src/preload/       Typed bridge between the interface and host
src/renderer/      React conversations, contacts, Library and settings
src/shared/        Shared contracts, schemas and product operation definitions
src/native-mac/    Native helper for authorized Mac application windows
browser-extension/ Bundled extension for explicitly shared browser tabs
tests/             Electron, integration and end-to-end validation
assets/screenshots/ Public product screenshots used by the README
build/             Packaging and release configuration
```

## Project resources

| Topic | Resources |
| --- | --- |
| Using the app | [Get started](#get-started) · [Features](#features) · [Data and permissions](#data-and-permissions) |
| Versions | [Releases](https://github.com/CMSKL/Aevoren/releases) |
| Contributing | [Contributing guide](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md) |
| Licensing | [License](LICENSE) · [Notices](NOTICE) · [Third-party inventory](THIRD_PARTY_NOTICES.md) · [Trademarks](TRADEMARKS.md) |

Internal guides, plans, research and validation records in `docs/` remain local and are excluded from Git and application packages. Public usage information is maintained in this README.

## Contributing, maintenance and license

Only three branches exist: **`dev`**, **`beta`** and **`master`**. All work is committed and pushed directly to `dev`; no feature branches are used. Validated changes are promoted `dev` → `beta` → `master`, with the testing deployment validated on `beta` before promotion. Release numbering starts at `0.1.0` in this repository. Release tags and titles must both be `v<package.json version>`, beginning with `v0.1.0`. Historical branches and archive tags from the previous repository must not be pushed here.

Allen and GitHub [CMSKL](https://github.com/CMSKL) are the same maintainer. Allen leads the project, with AI contributing development work. The [personal project record](https://www.minimalstudio.cn/allen/projects/aevoren.html) documents those roles and earlier project stages.

Aevoren is licensed under the [Apache License 2.0](LICENSE). The project name and icon are covered by the [trademark notice](TRADEMARKS.md); dependency licenses are listed in [Third-party notices](THIRD_PARTY_NOTICES.md).
