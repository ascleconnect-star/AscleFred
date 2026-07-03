# Ascle — On-Demand Teleconsultation: Deployment Guide

## 1. Repository structure

Add these files to your existing Ascle repo (paths matter for Netlify):

```
your-ascle-repo/
├── netlify.toml
├── package.json
├── netlify/
│   └── functions/
│       └── create-room.js
├── public/                      ← Netlify "publish" directory
│   ├── index.html               ← your existing app (index-6.html, renamed)
│   ├── consultation.html
│   └── consultation.js
└── sql/
    └── schema.sql                ← run in Supabase, not deployed
```

If your existing repo doesn't yet use a `public/` folder, either:
- move your current `index.html` into `public/`, **or**
- change `publish = "public"` to `publish = "."` in `netlify.toml` and drop `consultation.html`/`consultation.js` at the repo root instead.

Both `consultation.html` and `consultation.js` need to sit at the **same level** as your main app so relative paths (`/consultation.js`, `/.netlify/functions/create-room`) resolve correctly.

## 2. Supabase setup

1. Open your Supabase project → **SQL Editor**.
2. Paste and run `sql/schema.sql`. It's written with `IF NOT EXISTS` / `DROP POLICY IF EXISTS` guards, so it's safe even if `profiles` already exists.
3. Confirm RLS is enabled: **Table Editor → profiles / consultations → RLS toggle** should read "Enabled."
4. Under **Project Settings → API**, copy:
   - `Project URL` → used as `SUPABASE_URL`
   - `anon public` key → used as `SUPABASE_ANON` (client-side, safe to expose)
   - `service_role` key → used as `SUPABASE_SERVICE_ROLE_KEY` (**server-side only, never in any HTML/JS file**)

## 3. Daily.co setup

1. Create a Daily.co account and note your subdomain (e.g. `ascle.daily.co`).
2. **Dashboard → Developers → API Keys** → copy your API key → this becomes `DAILY_API_KEY`.
3. No rooms need to be pre-created — `create-room.js` creates them on demand, one per consultation, private + expiring automatically 2 hours after creation.

## 4. Wire up the two client-side config blocks

Edit the top of `public/consultation.js` (and your existing `index.html`, which already has the same pattern):

```js
const SUPABASE_URL  = 'xxxxx.supabase.co';
const SUPABASE_ANON = 'eyJ...';   // the anon public key — safe client-side
```

Do **not** put `DAILY_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY` in any client file. Those live only in Netlify's environment variables (next section) and are read via `process.env` inside `create-room.js`.

## 5. Connect GitHub → Netlify

1. Push this structure to a GitHub repository.
2. In Netlify: **Add new site → Import an existing project → GitHub** → select the repo.
3. Build settings (Netlify usually auto-detects these from `netlify.toml`, confirm they match):
   - **Build command:** `npm install`
   - **Publish directory:** `public`
   - **Functions directory:** `netlify/functions`
4. Deploy. Every push to your default branch (e.g. `main`) now triggers an automatic redeploy — that's your CI/CD pipeline, no extra GitHub Actions config needed for this feature.

## 6. Netlify environment variables

**Site settings → Environment variables → Add a variable.** Set these for the **Production** (and **Deploy previews**, if you test there) contexts:

| Key | Value | Exposed to browser? |
|---|---|---|
| `SUPABASE_URL` | Your Supabase project URL | No (function-only; the client copy is hardcoded in `consultation.js`/`index.html`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key | **Never** — server only |
| `DAILY_API_KEY` | Daily.co API key | **Never** — server only |
| `DAILY_DOMAIN` | Your Daily subdomain (optional, informational) | No |

⚠️ **Do not** prefix any of these with `VITE_`, `PUBLIC_`, `REACT_APP_`, or similar — those conventions cause some bundlers to inline vars into client bundles. This is a plain static site + Netlify Functions, so nothing here gets bundled into the browser unless you explicitly write it into an HTML/JS file, which is exactly why the anon key (safe) is hardcoded in the client files while the service role and Daily keys (unsafe) live only in `process.env` inside `netlify/functions/create-room.js`.

## 7. Smoke test after deploy

1. Sign up two test accounts: one with `role: patient`, one with `role: doctor`.
2. Insert a test row directly in Supabase (Table Editor → consultations → Insert row) with `patient_id`, `practitioner_id`, `status: scheduled`, `scheduled_at: now()`.
3. As the doctor, visit `https://your-site.netlify.app/consultation.html?id=<consultation_id>` → click **Start Consultation**.
4. As the patient (different browser/incognito), visit the same URL → click **Join Call**.
5. Confirm both video tiles connect, then have the doctor click **Leave Call** and verify the row's `status` flips to `completed` in Supabase.

## 8. Production hardening checklist (recommended next steps)

- Add a Daily.co **webhook** → a second Netlify function to catch `room.expired` / `participant.left` events server-side, as a backstop in case a client tab crashes before it can call `handleLeftMeeting`.
- Rate-limit `create-room.js` (e.g. Netlify's built-in rate limiting or a simple per-user counter in Supabase) to stop repeated room-creation calls from exhausting your Daily.co plan.
- Rotate `DAILY_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` periodically via Netlify's environment variable UI — rotation doesn't require a code change.
