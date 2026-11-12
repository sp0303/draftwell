# Draftwell

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
| Extracted resume data, theme, accent, chat history | MongoDB `draftwell_resumes` collection |
| Visitors | MongoDB `draftwell_users` collection, identified by an anonymous `dw_uid` cookie |

## How it works

- **Upload** (`POST /api/resumes`): the file is saved to disk, its text is read (pdf-parse / mammoth), and the text is turned into structured data. With an LLM connected that uses `llm.extractResume()`; otherwise the rule parser in `src/extract.js`.
- **Direct edits** on the page are saved with `PATCH /api/resumes/:id`. No LLM involved.
- **Chat** (`POST /api/resumes/:id/chat`) uses `llm.chat()` when connected, else the rules in `src/assistant.js`.
- **PDF** (`GET /api/resumes/:id/pdf`): Playwright renders the same template and CSS as the preview (`public/js/templates.js`, `public/css/resume.css`) in headless Chromium.

## Connecting the LLM

Fill in `extractResume()` and `chat()` in `src/llm.js` and set `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL` in `.env`. Every LLM call goes through that file.

## API

| Method | Path | Purpose |
|---|---|---|
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
