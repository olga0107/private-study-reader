# Private course reader

The application source and its development history can be public. Course text,
figures, diagram definitions, search data, and personal annotations stay private.

## Boundaries

- The private content repository retains the original Markdown, images, and history.
- The public code repository contains the Vue reader, reusable annotation tools,
  schema migrations, tests, and deployment configuration. It starts from a clean
  history and never copies the private repository's `.git` directory.
- GitHub Pages serves the login form, reader code, and shared styles.
- Supabase Auth accepts administrator-created accounts only. Disable sign-ups
  in the project dashboard; do not rely on hiding a registration form.
- A private `site-content` bucket serves content through authenticated requests.
  `is_reader()` also checks that the account exists and is not banned.
- `annotations` uses row-level security. The only client write entrypoint,
  `save_annotation`, derives its owner from the session, checks the expected
  revision, and updates atomically. Clients cannot write arbitrary owners.

## Content publishing

`npm run build:content` renders the existing VitePress notes, then exports only
the document HTML, relevant diagram data, and referenced images. Application
scripts and VitePress page modules are not uploaded or published as content.

`npm run upload:content` uploads to a content-addressed release directory and
downloads every object to compare bytes. Only after successful verification does
it replace `current.json`. The previous release stays available to readers
already using it. Historical releases consume storage; an administrator can
remove obsolete `releases/<id>/` prefixes after confirming no active reader
needs them. Do not remove the release referenced by `current.json`.

Service-role credentials are used only by this private release job. Set
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as private repository Secrets.
Never put the service-role key into a frontend variable or an artifact.

## Reading and searching

The private export converts PNG illustrations to lossless WebP only when the
result is smaller and a decoded RGBA comparison proves pixel equality. Original
source images remain unchanged. The upload verifies every object before changing
the current-release manifest; previous releases remain available.

After login, the reader fetches the manifest and page JSON with the user's token.
Image requests also carry authorization. Only images within 600 pixels of the
viewport are queued, with at most two downloads at once. Leaving that area
cancels unfinished downloads so the new reading position takes priority.
Image dimensions preserve the document layout, and failed downloads have an
individual retry button. Loading the chapter does not wait for its images.

Successful image bytes are cached in tab memory (32 MiB, least recently used).
Cache keys include the content release. Logout and account changes clear the
cache, abort pending downloads, and prevent late responses from refilling it.
Blob URLs are released on navigation and logout. No image bytes are written to
localStorage, IndexedDB, a service worker, or the browser HTTP cache.
Course files and full-text search data are held in memory, not a
public bundle, service worker, or shared persistent cache. Page HTML is sanitized
before rendering. The existing diagram renderer receives private data at runtime.

Hash routes work on GitHub Pages without a server rewrite. Previous/next links
connect only lecture pages. Existing typography, reading controls, highlighting,
handwriting, diagrams, and code copying remain available.

## Personal data

Each account has a separate local cache and durable pending-change queue.
Local saves use a browser Web Lock to serialize concurrent tabs, and report
success only after writing the device cache. Network requests use the token
verified for that account, so a later account switch cannot redirect a queued
private note into another account.
Edits remain local while disconnected and retry on reconnection. The latest
revision from the server is required for an update. Two-device conflicts retain
both copies and ask the reader to select a version; no clock-based silent overwrite.
An editor keeps the version that was present when it opened, so saving an older
draft also detects changes received while the editor was open.
Deleting all marks saves an empty snapshot so other devices also see the deletion.

Synchronization runs in the background. Reading pages show no persistent sync
dashboard, account ownership text, last-connection time or migration controls.
Only a save error or version conflict displays recovery actions. The existing
text-mark drawer retains its export/import controls.

Old unscoped browser annotations are not silently assigned to the next person
who logs in. Data stored on an old origin must first be exported there; a new
origin cannot read another site's local storage.

Handwriting retains the existing viewport/font-size coordinate format. Sync
preserves the strokes, but line wrapping across very different screen layouts
can still move their visual alignment. Text marks relocate using surrounding text.

## Accounts and removal

Create users through the Supabase administrator dashboard with email/password.
There is no registration UI or browser-side administrator key. Banning or deleting
an account blocks future protected reads and writes, including with a previously
issued JWT. Already downloaded material cannot be remotely erased or protected
against screenshots by an authorized reader.

## Local verification

Copy `.env.example` to `.env.local` and supply only the public project URL and
publishable/anon key. Run `npm run dev:reader` or `npm run build:reader` in the
private integration checkout. In the exported public repository use `npm run dev`
and `npm run build`.

Run `npm test` for local regression tests. For opt-in live permission tests, set
`RUN_LIVE_TESTS=1`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY`, then run `node --test tests/backend.live.test.mjs`.
The test creates two temporary accounts and a private fixture, exercises
anonymous denial, isolation, CAS conflicts and banning, then removes its fixtures.

## Release checklist

1. Apply the schema migration to the intended Supabase project; verify sign-ups
   remain disabled and the storage bucket remains private.
2. Upload and verify the private content before deploying the reader.
3. Export public source with `npm run export:public`; inspect the allowlisted files
   and scan the source and built bundle for content or privileged credentials.
4. Configure public repository variables `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY`, then deploy using the supplied Pages workflow.
5. Verify actual login, navigation, images, diagrams, marks, ink, synchronization,
   logout and anonymous denial on the deployed origin.
6. Retire the previous encrypted HTML site and its exposed assets. Its public
   Git history also contains course content; a new deployment cannot remove past
   copies. Keep any needed backups in private storage before retiring it.
7. Once the old reader is retired, remove its obsolete master-key table and
   deployment secrets. They are not used by this architecture.
