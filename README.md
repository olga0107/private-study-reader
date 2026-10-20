# olga’s study

A personal study space with a public, reviewable codebase.
Readers use fixed administrator-created accounts to access course material,
highlight text, write notes, draw with a stylus, and synchronize their annotations.

This repository contains application code and database rules. It does not contain
the real course notes, slides, user data, account passwords, or administrator keys.

## Run locally

Use Node.js 22 or newer.

```sh
npm ci
cp .env.example .env.local
# Set the public Supabase project URL and anon/publishable key.
npm run dev
```

Apply `supabase/migrations/202610200001_private_reader.sql` to your project,
disable public sign-ups, and create an account in the Supabase dashboard.
Use a separate private content checkout to build and upload course material.
The migration alone does not create course content or user accounts.

## Verify and deploy

```sh
npm test
npm run build
```

Set repository variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
Select GitHub Actions as the Pages source. The supplied workflow builds and
deploys only the reader. Privileged service-role credentials never belong in
this repository's frontend configuration.

See [architecture and operations](docs/private-reader-architecture.md) for the
content pipeline, isolation rules, conflicts, backups, and live verification.

## Development history

Use commits for meaningful changes and pull requests for review. Database
migrations and regression tests are part of the application, so changes to
authentication and synchronization remain reviewable alongside the UI.
