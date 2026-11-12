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
| Visitors and accounts | MongoDB `resumely_users` (guests, plus `google` profile once signed in) |
| Sessions | MongoDB `resumely_sessions`, one per browser, referenced by the `rl_sid` cookie; unused sessions expire after 180 days |

## How it works

- **Upload** (`POST /api/resumes`): the file is saved to disk, its text is read (pdf-parse / mammoth), and the text is turned into structured data. With an LLM connected that uses `llm.extractResume()`; otherwise the rule parser in `src/extract.js`.
- **Direct edits** on the page are saved with `PATCH /api/resumes/:id`. No LLM involved.
- **Chat** (`POST /api/resumes/:id/chat`) uses `llm.chat()` when connected, else the rules in `src/assistant.js`.
- **PDF** (`GET /api/resumes/:id/pdf`): Playwright renders the same template and CSS as the preview (`public/js/templates.js`, `public/css/resume.css`) in headless Chromium.

## Google sign-in

Sign-in is optional. Guests can use everything; signing in with Google keeps resumes across browsers. When a guest signs in, the resumes they made as a guest move to their account.

Set `GOOGLE_CLIENT_ID` in `.env` to an OAuth client ID of type *Web application* from Google Cloud Console, with your site's origin (for example `https://resume.sarey.tech`) under *Authorized JavaScript origins*. The browser gets an ID token from Google; `POST /api/auth/google` verifies it with `google-auth-library` (`src/auth.js`). With no client ID set, the button is hidden.

## Connecting the LLM

Fill in `extractResume()` and `chat()` in `src/llm.js` and set `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` in `.env`. Every LLM call goes through that file.

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
| PATCH | `/api/resumes/:id` | Save `data`, `theme`, `accent`, `title` |
| POST | `/api/resumes/:id/chat` | Send a chat message |
| GET | `/api/resumes/:id/pdf` | Download PDF |
| GET | `/api/resumes/:id/file` | Download the original upload |
| DELETE | `/api/resumes/:id` | Delete the resume and its file |

## Tests

`npm run test:e2e -- path/to/resume.pdf` runs every API route against an in-memory MongoDB, including a real upload and PDF render.
