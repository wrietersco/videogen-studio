# VideoGen licence server

Accounts, licence keys, the four plans and their quotas, the AI relay, and the
superadmin console. Modelled on Snap Projects' Cloud Run proxy, and deployed
beside it in the same Google project (`brain-3bc3a`) as its own Cloud Run
service with its own `vg_*` Firestore collections — nothing of Snap's is read
or changed.

```
desktop app ──ID token + device──▶ /v1/*      accounts, plan, start an AI video
            ──same──▶             /v1/ai/*    relay: plan check → provider with the server's key → charge
browser     ──admin ID token──▶   /admin/*    superadmin API (vg_admins allow-list, revocation checked)
                                  /console/   superadmin console (static, strict CSP)
```

## Rules it enforces

- **Plans** (`src/shared/plans.ts`, editable live in the console): Free 3, Plus 10
  (Luna), Pro 15 (Terra), Ultra 27 (Sol) AI videos a month per seat; per-plan
  model lists, clips per video, longest video, a $ cap per video and per month.
  Programmatic videos never touch the server and are unlimited.
- **A video is counted once a month** when `/v1/videos/start` is called for a new
  project; edits of the same project are free of count but stay inside the
  video's $ cap. Every relayed call must name a started video (or fall in the
  small daily helper budget) and a model on the plan's list.
- **Accounts**: Firebase email/password; AI needs a verified email; each account
  may register `devicesPerSeat` computers; one free trial per account.
- **Licences**: keys are `vg_live_` + 32 random characters, shown once, stored only
  as a SHA-256 hash; seats are taken atomically. Lapse ladder: active → grace
  (full plan) → Free allowances → AI off. Suspend/rotate in the console.
- **Own keys** only where the superadmin ticks "Own API keys" on a licence.
- Every admin change and every new AI video is written to `vg_audit`.

## One-time setup (brain-3bc3a)

1. Secrets the relay uses (OpenAI and Gemini already exist for Snap):
   `openai-live-key`, `gemini-live-key`, optional `elevenlabs-live-key`
   (`printf '%s' "$KEY" | gcloud secrets create elevenlabs-live-key --data-file=-`).
   Grant the Cloud Run service account `roles/secretmanager.secretAccessor` on each.
2. Firebase Console → Authentication: Email/Password is already on for Snap.
3. Deploy: `cd server && npm install && FIREBASE_WEB_API_KEY=<Snap Projects Desktop key> ./deploy.sh`
   (not the Firebase browser key: it only allows Snap's websites as referrers)
   The URL must match `LICENSE_SERVER` in `src/main/license/session.ts`
   (`https://videogen-license-server-539536929675.us-central1.run.app`); if Cloud
   Run prints another, update that constant before building the app.
4. Make yourself superadmin (sign up in the app or Firebase first):
   `gcloud auth application-default login` then `node scripts/add-admin.mjs you@example.com`.
5. Open `<service URL>/console/` and sign in.

No `firestore.rules` change is needed: only this server (Admin SDK) touches
`vg_*`, and the default deny already blocks every client.

## Local development

`npm run dev` → `http://127.0.0.1:8787` with an in-memory store and dev tokens
(`dev:<uid>:<email>:verified`; console sign-in `dev:admin:admin@example.com:verified`).
Run the app against it with `VIDEOGEN_LICENSE_SERVER=http://127.0.0.1:8787 VIDEOGEN_DEV_AUTH=1 npm run dev`.
Set `OPENAI_API_KEY` / `GEMINI_API_KEY` in the environment to relay real calls.
Tests: `npx vitest run tests/licensing.test.ts` (no network, no credentials).
