# Resumely

Resume builder: upload a resume, pick one of 8 themes, edit it directly on the page or by chatting, and download a PDF that matches the preview.

## Setup

```bash
npm run setup          # installs packages and the Chromium used for PDF export
cp .env.example .env   # then set MONGO_URL
npm start              # http://localhost:3000
```

No MongoDB yet? `node scripts/dev-memory.js` runs the app against a temporary in-memory database (data is lost when it stops).

## Where data lives

| What | Where |
|---|---|
| Uploaded resume files | On disk under `UPLOAD_DIR` (default `storage/uploads/<user id>/`) |
| Extracted resume data, theme, accent, chat history | MongoDB `resumely_resumes` collection |
| Accounts | MongoDB `resumely_users`, one per Google account (`google.sub`, email, name, picture) |
| Sessions | MongoDB `resumely_sessions`, one per browser, referenced by the `rl_sid` cookie; unused sessions expire after 180 days |

## How it works

- **Upload** (`POST /api/resumes`): the file is saved to disk, its text is read (pdf-parse / mammoth), and the text is turned into structured data. With an LLM connected that uses `llm.extractResume()`; otherwise the rule parser in `src/extract.js`.
- **Direct edits** on the page are saved with `PATCH /api/resumes/:id`. No LLM involved.
- **Chat** (`POST /api/resumes/:id/chat`) uses `llm.chat()` when connected, else the rules in `src/assistant.js`.
- **PDF** (`GET /api/resumes/:id/pdf`): Playwright renders the same template and CSS as the preview (`public/js/templates.js`, `public/css/resume.css`) in headless Chromium.

## Google sign-in

Sign-in with Google is required. Signed-out visitors only see the home page, and every `/api/resumes` route returns 401 without a session.

Set `GOOGLE_CLIENT_ID` in `.env` to an OAuth client ID of type *Web application* from Google Cloud Console, with your site's origin (for example `https://resume.sarey.tech`) under *Authorized JavaScript origins*. The browser gets an ID token from Google; `POST /api/auth/google` verifies it with `google-auth-library` (`src/auth.js`). With no client ID set, nobody can sign in, and the home page says so.

## Connecting the LLM

The AI runs through OpenRouter (`src/llm.js`). Set `LLM_API_KEY`, `LLM_MODEL` and optionally `LLM_FALLBACK_MODELS` in `.env`. Every LLM call goes through that file.

## Tailoring to a job

Each resume can hold a target job description (`jd`), saved from the "Target job" box above the chat or by pasting a job posting straight into the chat. When it is set, chat edits aim at that job: relevant work first, the job's keywords where the resume supports them, and a list of requirements the resume doesn't cover. Nothing is invented.

## AI credits and the admin page

Every account has an AI credit balance (`credits` on the user; new accounts get `AI_STARTING_CREDITS`, default 100). Each AI call costs 1 credit per 1,000 tokens used (at least 1). At 0 credits the model is skipped and the built-in rules answer. Users also carry usage counters (`stats`: AI requests, tokens, credits used, uploads, PDF downloads).

Google accounts listed in `ADMIN_EMAILS` see an **Admin** link (`#admin`): every user with their balance and usage, plus Add / Set to for credits. Each change is kept in the user's `creditLog`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/me` | Signed-in profile (or guest) and the Google client ID |
| POST | `/api/auth/google` | Sign in with a Google ID token (`credential`) |
| POST | `/api/auth/logout` | Sign out of this browser |
| GET | `/api/resumes` | List this visitor's resumes |
| POST | `/api/resumes` | Upload a file (`resume` form field) |
| POST | `/api/resumes/sample` | Create a resume from the sample profile |
| GET | `/api/resumes/:id` | Full resume |
| PATCH | `/api/resumes/:id` | Save `data`, `theme`, `accent`, `title`, `jd` (job description) |
| POST | `/api/resumes/:id/chat` | Send a chat message |
| GET | `/api/resumes/:id/pdf` | Download PDF |
| GET | `/api/resumes/:id/file` | Download the original upload |
| DELETE | `/api/resumes/:id` | Delete the resume and its file |
| GET | `/api/admin/users` | Admin: users, credits and usage |
| POST | `/api/admin/users/:id/credits` | Admin: `{ add: n }` or `{ set: n }` |

## Tests

`npm run test:e2e -- path/to/resume.pdf` runs every API route against an in-memory MongoDB, including a real upload and PDF render.
