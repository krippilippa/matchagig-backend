## MatchaGig Backend API

Minimal Fastify backend for uploading résumés, having OpenAI clean/linearize text, and asking questions against the uploaded file.

### Base URL
- Local dev: `http://localhost:8787`

### Auth
- None (dev). CORS is open. Put your OpenAI key in `.env`.

### Environment
- Required: `OPENAI_API_KEY`
- Optional: `OPENAI_MODEL` (defaults to `gpt-4o-mini`), `PORT` (defaults to `8787`)

### Start
```bash
npm ci
cp ENV_EXAMPLE.txt .env  # then edit with your key
npm run dev
```

### Error format
All errors follow this shape:
```json
{ "error": { "code": "STRING", "message": "STRING", "details": { } } }
```
Common `code` values: `BAD_REQUEST`, `UNSUPPORTED_MEDIA_TYPE`, `PAYLOAD_TOO_LARGE`, `CONFIG`, `OPENAI_ERROR`, `INTERNAL`.

---

## Endpoints

### GET /health
Quick health check.

- Response 200:
```json
{ "ok": true, "ts": "2025-01-01T12:34:56.000Z" }
```

---

### POST /v1/upload
Upload a résumé (PDF/DOCX/TXT). The server uploads the file to OpenAI Files and asks the Responses API to return structured JSON with key fields and faithful full text. No local parsing.

- Content-Type: `multipart/form-data`
- Form fields:
  - `file`: the file to upload (.pdf, .docx, .txt). Max 10 MB.

- Response 200:
```json
{
  "fileId": "file_abc123",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "blurb": "Full-stack engineer with 7+ years building SaaS and APIs in Node and React.",
  "text": "...verbatim plain-text extraction of the document..."
}
```
- Response 400:
```json
{ "error": { "code": "BAD_REQUEST", "message": "No file provided", "details": {} } }
```
- Response 413:
```json
{ "error": { "code": "PAYLOAD_TOO_LARGE", "message": "File exceeds 10MB", "details": {} } }
```
- Response 415:
```json
{ "error": { "code": "UNSUPPORTED_MEDIA_TYPE", "message": "Use multipart/form-data", "details": {} } }
```

- cURL example:
```bash
curl -F file=@/path/to/Resume.pdf http://localhost:8787/v1/upload
```

Notes:
- The returned `fileId` can be reused for later queries without re-uploading.

---

### POST /v1/query
Ask a question against a previously uploaded file.

- Content-Type: `application/json`
- Body:
```json
{ "fileId": "file_abc123", "question": "Give a 5-line brief..." }
```
- Response 200:
```json
{ "text": "...answer based on the uploaded résumé..." }
```
- Response 400:
```json
{ "error": { "code": "BAD_REQUEST", "message": "Required: { fileId, question }", "details": {} } }
```

- cURL example:
```bash
curl -X POST http://localhost:8787/v1/query \
  -H 'Content-Type: application/json' \
  -d '{"fileId":"file_abc123","question":"Give a 5-line brief..."}'
```

---

### POST /v1/summary
Extract objective résumé data in structured JSON.

- Content-Type: `application/json`
- Body: provide either `fileId` or `text` (not both)
```json
{ "fileId": "file_abc123" }
```
or
```json
{ "text": "...resume plain text..." }
```
- Response 200:
```json
{
  "jobsCount": 5,
  "yearsExperience": 8,
  "companies": ["Acme Inc", "Globex"],
  "roles": ["Senior Software Engineer", "Team Lead"],
  "education": [
    { "degree": "B.Sc.", "field": "Computer Science", "institution": "University X", "year": "2016" }
  ],
  "hardSkills": ["JavaScript", "React", "Node.js", "PostgreSQL"],
  "softSkills": ["Leadership", "Collaboration", "Communication"]
}
```
- Response 400:
```json
{ "error": { "code": "BAD_REQUEST", "message": "Provide either fileId OR text, not both", "details": {} } }
```

- cURL examples:
```bash
curl -X POST http://localhost:8787/v1/summary \
  -H 'Content-Type: application/json' \
  -d '{"fileId":"file_abc123"}'

curl -X POST http://localhost:8787/v1/summary \
  -H 'Content-Type: application/json' \
  -d '{"text":"...resume text..."}'
```


## Integration Notes
 - CORS is open in dev. You can call from the browser directly during prototyping.
 - Expect Responses API calls to take a few seconds for large files.
 - If port 8787 is busy, set `PORT` in `.env`.
 - Returned `fileId` is stable and can be stored for future queries.

---

### POST /v1/redflags
Scan a résumé for objective red flags. Returns JSON with up to 5 items; empty list means no major red flags.

- Content-Type: `application/json`
- Body: provide either `fileId` or `text` (not both)
```json
{ "fileId": "file_abc123" }
```
or
```json
{ "text": "...resume plain text..." }
```
- Response 200 (examples):
```json
{ "items": [
  { "title": "Employment gap", "description": "9-month gap between Jan 2020 and Oct 2020." },
  { "title": "Overclaiming skills", "description": "Lists 35+ disparate tools with no matching roles or timelines." }
] }
```
No flags:
```json
{ "items": [] }
```
- Response 400:
```json
{ "error": { "code": "BAD_REQUEST", "message": "Provide either fileId OR text, not both", "details": {} } }
```

- cURL examples:
```bash
curl -X POST http://localhost:8787/v1/redflags \
  -H 'Content-Type: application/json' \
  -d '{"fileId":"file_abc123"}'

curl -X POST http://localhost:8787/v1/redflags \
  -H 'Content-Type: application/json' \
  -d '{"text":"...resume text..."}'
```
