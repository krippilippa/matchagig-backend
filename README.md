# MatchaGig Backend API

AI-powered résumé processing backend built with Fastify and OpenAI. Upload résumés once, get canonical text storage, and run intelligent parsing queries without re-uploading.

## 🚀 Features

- **Canonical Resume Storage**: Upload once, reuse forever
- **AI-Powered Text Extraction**: Clean, normalized text from PDF/DOCX/TXT
- **Intelligent Overview Generation**: 7 parallel micro-prompts for comprehensive data
- **Persistent Storage**: Survives server restarts with file-based persistence
- **Structured Data**: Zod-validated, consistent JSON responses

## 🛠️ Setup

### Prerequisites
- Node.js 18+
- OpenAI API key

### Installation
```bash
npm ci
cp ENV_EXAMPLE.txt .env  # Edit with your OpenAI key
npm run dev
```

### Environment Variables
```bash
OPENAI_API_KEY=your_openai_key_here
OPENAI_MODEL=gpt-5-nano  # Optional, defaults to gpt-5-nano
PORT=8787                 # Optional, defaults to 8787
```

## 📡 API Endpoints

### Base URL
- Local: `http://localhost:8787`
- Production: `https://your-domain.com`

### Error Format
All errors follow this structure:
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": {}
  }
}
```

Common error codes: `BAD_REQUEST`, `NOT_FOUND`, `PROCESSING_ERROR`, `CONFIG`

---

## 🔄 Core Endpoints

### POST /v1/upload
Upload a résumé and get canonical storage with AI-extracted metadata.

**Request:**
- Content-Type: `multipart/form-data`
- Body: `file` field with PDF/DOCX/TXT (max 10MB)

**Response 200:**
```json
{
  "resumeId": "e29663e6-b34d-4f21-b147-b456d96d1d6c",
  "name": "Ana Noguera",
  "email": "anoguera2020@gmail.com",
  "phone": "+34695511682",
  "length": 7048
}
```

**cURL Example:**
```bash
curl -F file=@/path/to/Resume.pdf http://localhost:8787/v1/upload
```

**Notes:**
- Returns a `resumeId` (UUID) for future queries
- AI extracts and normalizes text automatically
- Text is cleaned (hyphenation, whitespace, headers/footers removed)
- Data persists across server restarts

---

### POST /v1/overview
Generate comprehensive résumé overview using 7 parallel AI micro-prompts.

**Request:**
- Content-Type: `application/json`
- Body: `{ "resumeId": "uuid-here" }`

**Response 200:**
```json
{
  "resumeId": "e29663e6-b34d-4f21-b147-b456d96d1d6c",
  "name": "Ana Noguera",
  "email": "anoguera2020@gmail.com",
  "phone": "+34695511682",
  "overview": {
    "title": "HEAD OF SALES",
    "seniorityHint": "Lead/Head",
    "employer": "INFORCERT-TINEXTA GROUP",
    "yoe": 20,
    "yoeBasis": "self-reported",
    "education": {
      "level": "Master",
      "degreeName": "MBA",
      "field": "Business Administration",
      "institution": "ESIC Business School",
      "year": "2015"
    },
    "topAchievements": [
      "Exceeded group sales targets Y-o-Y by generating annual revenue",
      "Met sales target consistently by securing multi-year contracts",
      "Annual growth achieved through strategic partnerships"
    ],
    "functions": ["Sales", "Business Development"],
    "location": {
      "city": null,
      "country": null
    },
    "employerRaw": "INFORCERT-TINEXTA GROUP",
    "employerDescriptor": null
  },
  "metadata": {
    "promptVersion": "v1",
    "canonicalTextLength": 7045,
    "timestamp": "2025-08-15T10:16:52.379Z"
  }
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:8787/v1/overview \
  -H "Content-Type: application/json" \
  -d '{"resumeId": "e29663e6-b34d-4f21-b147-b456d96d1d6c"}'
```

**Overview Fields Explained:**
- **title**: Current job title (exact wording)
- **seniorityHint**: Junior/Mid/Senior/Lead/Head/Unknown
- **employer**: Clean organization name (no dates/locations)
- **yoe**: Years of experience (self-reported preferred, date-derived fallback)
- **yoeBasis**: Source of YOE data
- **education**: Highest completed education level
- **topAchievements**: 3 outcome-focused achievements (no duties)
- **functions**: 1-2 broad professional domains (Title Case)
- **location**: City/country if stated
- **employerRaw**: Full employer string as written
- **employerDescriptor**: Tagline/sector info only (no dates/remote)

---

### POST /v1/query
Ask custom questions against a stored résumé.

**Request:**
- Content-Type: `application/json`
- Body: `{ "resumeId": "uuid", "question": "Your question here" }`

**Response 200:**
```json
{
  "resumeId": "e29663e6-b34d-4f21-b147-b456d96d1d6c",
  "question": "What are the candidate's key strengths?",
  "text": "AI-generated answer based on the résumé content...",
  "textLength": 245
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:8787/v1/query \
  -H "Content-Type: application/json" \
  -d '{"resumeId": "uuid-here", "question": "What are the key strengths?"}'
```

---

### GET /v1/resume/:resumeId
Retrieve stored résumé data and canonical text.

**Response 200:**
```json
{
  "resumeId": "e29663e6-b34d-4f21-b147-b456d96d1d6c",
  "name": "Ana Noguera",
  "email": "anoguera2020@gmail.com",
  "phone": "+34695511682",
  "canonicalText": "Cleaned, normalized résumé text...",
  "uploadedAt": 1692180000000
}
```

---

## 🔧 Technical Details

### AI Models Used
- **Upload**: `gpt-5-nano` for text extraction and metadata parsing
- **Overview**: `gpt-5-nano` for 7 parallel micro-prompts
- **Query**: `gpt-5-nano` for custom questions

### Data Persistence
- **In-memory**: Fast access during runtime
- **File-based**: `resume-storage.json` for persistence across restarts
- **Auto-save**: Every upload automatically persists to disk
- **Auto-load**: Server automatically loads existing data on startup

### Text Processing Pipeline
1. **AI Extraction**: OpenAI extracts text from PDF/DOCX/TXT
2. **Normalization**: Fixes hyphenation, whitespace, headers/footers
3. **Canonical Storage**: Single source of truth for all queries
4. **Micro-prompts**: Targeted AI analysis for specific data points

### Micro-Prompts (Overview System)
1. **Current Title**: Job title + seniority hint
2. **Current Employer**: Organization name + descriptor
3. **YOE Estimate**: Self-reported + date-derived values
4. **Education**: Highest completed level + details
5. **Achievements**: Outcome-focused accomplishments
6. **Functions**: Broad professional domains
7. **Location**: City/country if stated

---

## 🚦 Integration Notes

### Frontend Integration
- **Upload Flow**: Upload → get `resumeId` → store for future use
- **Overview Flow**: Use `resumeId` → get comprehensive structured data
- **Query Flow**: Use `resumeId` → ask custom questions
- **Error Handling**: Check `error.code` for specific error types

### Performance
- **Upload**: 5-15 seconds (depends on file size and AI processing)
- **Overview**: 3-8 seconds (7 parallel AI calls)
- **Query**: 2-5 seconds (single AI call)
- **Storage**: Instant (in-memory with disk persistence)

### CORS
- **Development**: Open CORS for local development
- **Production**: Configure CORS for your frontend domain

### Rate Limiting
- **Development**: None
- **Production**: Implement rate limiting based on your needs

---

## 📊 Example Workflows

### 1. Resume Processing Pipeline
```bash
# 1. Upload resume
curl -F file=@resume.pdf http://localhost:8787/v1/upload
# Returns: { "resumeId": "uuid", "name": "...", ... }

# 2. Generate overview
curl -X POST http://localhost:8787/v1/overview \
  -d '{"resumeId": "uuid"}'
# Returns: comprehensive structured data

# 3. Ask custom questions
curl -X POST http://localhost:8787/v1/query \
  -d '{"resumeId": "uuid", "question": "What are the key achievements?"}'
```

### 2. Batch Processing
```bash
# Upload multiple resumes
for file in resumes/*.pdf; do
  curl -F file=@$file http://localhost:8787/v1/upload
done

# Process all stored resumes
curl -X POST http://localhost:8787/v1/overview \
  -d '{"resumeId": "stored-uuid-1"}'
```

---

## 🐛 Troubleshooting

### Common Issues
- **"Resume not found"**: Upload the resume first, then use the returned `resumeId`
- **Processing errors**: Check OpenAI API key and model availability
- **Storage persistence**: Ensure write permissions for `resume-storage.json`

### Debug Information
- Check server logs for detailed error messages
- Verify OpenAI API key is valid and has credits
- Confirm file uploads are under 10MB limit

---

## 🔮 Future Enhancements

- **Database Integration**: Replace file storage with PostgreSQL/MongoDB
- **Batch Processing**: Process multiple resumes simultaneously
- **Advanced Analytics**: Skills matching, job fit scoring
- **Webhook Support**: Notify frontend of processing completion
- **Caching Layer**: Redis for improved performance
