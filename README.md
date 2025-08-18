# MatchaGig Backend API

AI-powered résumé processing backend built with Fastify and OpenAI. Upload résumés once, get canonical text storage, and run intelligent parsing queries without re-uploading. Now with **Job Description parsing** and **intelligent caching** for both resumes and JDs.

## 🚀 Features

- **Canonical Resume Storage**: Upload once, reuse forever
- **AI-Powered Text Extraction**: Clean, normalized text from PDF/DOCX/TXT
- **Intelligent Overview Generation**: 7 parallel micro-prompts for comprehensive data
- **Job Description Parsing**: 4 parallel micro-prompts for JD analysis
- **Smart Caching System**: 24-hour cache for both resume overviews and JD results
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

Common error codes: `BAD_REQUEST`, `NOT_FOUND`, `PROCESSING_ERROR`, `CONFIG`, `JD_ERROR`, `OVERVIEW_ERROR`

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
Generate comprehensive résumé overview using 7 parallel AI micro-prompts. **Now with intelligent caching** - subsequent requests within 24 hours return instantly from cache.

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
    "languages": [
      { "name": "English", "proficiency": "Native" },
      { "name": "Spanish", "proficiency": "C2" }
    ],
    "availability": { "availability": "Immediate", "noticeDays": null },
    "topHardSkills": ["Salesforce", "HubSpot", "Excel", "CRM"],
    "certifications": [
      { "name": "Sales Management", "issuer": "Sales Institute", "year": "2023" }
    ],
    "peopleManagedMax": 15,
    "hiringExperience": true,
    "publicLinks": {
      "linkedin": "https://linkedin.com/in/ana-noguera",
      "github": null,
      "website": null
    },
    "employerRaw": "INFORCERT-TINEXTA GROUP",
    "employerDescriptor": null
  },
  "metadata": {
    "promptVersion": "v1",
    "canonicalTextLength": 7045,
    "timestamp": "2025-08-15T10:16:52.379Z",
    "cached": false  // true if retrieved from cache
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
- **languages**: Array of languages with CEFR proficiency levels
- **availability**: Immediate/Notice/Unknown with notice period
- **topHardSkills**: 5-10 concrete tools/platforms/technical competencies
- **certifications**: Professional certifications/licenses
- **peopleManagedMax**: Largest team size managed
- **hiringExperience**: Boolean for hiring/recruiting experience
- **publicLinks**: Social media and portfolio links (normalized URLs)
- **employerRaw**: Full employer string as written
- **employerDescriptor**: Tagline/sector info only (no dates/remote)

---

### POST /v1/jd
Parse job descriptions using 4 parallel AI micro-prompts. **Now with intelligent caching** - identical JD text returns cached results instantly.

**Request:**
- Content-Type: `application/json`
- Body: `{ "jdText": "Your job description text here..." }`

**Response 200:**
```json
{
  "jdHash": "a1b2c3d4e5f6g7h8",
  "jd": {
    "roleOrg": {
      "title": "Technical Sales Representative",
      "seniorityHint": "Mid",
      "employer": "GigDeveloper",
      "functions": ["Sales", "Business Development"]
    },
    "logistics": {
      "location": { "city": null, "country": null, "workMode": "Remote" },
      "workAuthorization": null,
      "languages": ["English"],
      "availability": { "earliestStart": null, "noticeDays": null }
    },
    "requirements": {
      "yoeMin": null,
      "educationMin": "None",
      "certifications": [],
      "peopleScopeReq": { "directReportsMin": null }
    },
    "successSignals": {
      "topHardSkills": ["LinkedIn", "IT technologies", "software development terms"],
      "keyOutcomes": [
        { "text": "Identify & engage prospects" },
        { "text": "Run qualification calls" },
        { "text": "Coordinate onboarding comms" },
        { "text": "Drive retention & growth" }
      ],
      "industryHints": ["Information Technology", "Staffing and Recruiting", "Technology"]
    }
  },
  "metadata": {
    "promptVersion": "v1",
    "jdTextLength": 1247,
    "timestamp": "2025-08-15T10:16:52.379Z"
  }
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:8787/v1/jd \
  -H "Content-Type: application/json" \
  -d '{"jdText": "Technical Sales Representative – IT Staffing Startup (Remote)..."}'
```

**JD Fields Explained:**
- **roleOrg**: Job title, seniority, employer, and functions
- **logistics**: Location, work mode, work authorization, languages, availability
- **requirements**: YOE + education + certifications + team scope
- **successSignals**: Hard skills + key outcomes + industry hints

---

### GET /v1/jd/:jdHash
Retrieve cached JD results by hash ID.

**Response 200:**
```json
{
  "jdHash": "a1b2c3d4e5f6g7h8",
  "jd": { /* same structure as POST response */ },
  "metadata": {
    "promptVersion": "v1",
    "jdTextLength": 1247,
    "timestamp": "2025-08-15T10:16:52.379Z",
    "cached": true,
    "retrievedAt": "2025-08-15T10:20:00.000Z"
  }
}
```

**cURL Example:**
```bash
curl http://localhost:8787/v1/jd/a1b2c3d4e5f6g7h8
```

---

### GET /v1/jd
List all cached JDs and storage information.

**Response 200:**
```json
{
  "totalCached": 5,
  "jdHashes": ["a1b2c3d4e5f6g7h8", "b2c3d4e5f6g7h8i9"],
  "metadata": {
    "timestamp": "2025-08-15T10:20:00.000Z"
  }
}
```

**cURL Example:**
```bash
curl http://localhost:8787/v1/jd
```

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
- **JD Parsing**: `gpt-5-nano` for 4 parallel micro-prompts
- **Query**: `gpt-5-nano` for custom questions

### Data Persistence
- **In-memory**: Fast access during runtime
- **File-based**: `resume-storage.json` for persistence across restarts
- **Auto-save**: Every upload/overview/JD automatically persists to disk
- **Auto-load**: Server automatically loads existing data on startup

### Caching System
- **Resume Overviews**: 24-hour cache with automatic storage
- **JD Results**: 24-hour cache with hash-based identification
- **Cache Keys**: Resume ID for overviews, SHA256 hash for JDs
- **Auto-expiry**: Cache automatically expires after 24 hours
- **Disk Persistence**: Cached data survives server restarts

### Text Processing Pipeline
1. **AI Extraction**: OpenAI extracts text from PDF/DOCX/TXT
2. **Normalization**: Fixes hyphenation, whitespace, headers/footers
3. **Canonical Storage**: Single source of truth for all queries
4. **Micro-prompts**: Targeted AI analysis for specific data points

### Micro-Prompts (Overview System - 7 prompts)
1. **role_header**: Current title + employer + location + seniority
2. **experience_signals**: YOE + functions + industries
3. **profile_extras**: Languages + availability + public links
4. **credentials**: Education + certifications
5. **top3_achievements**: Outcome-focused accomplishments
6. **leadership_summary**: Team management + hiring experience
7. **top_hard_skills**: Technical tools and competencies

### Micro-Prompts (JD System - 4 prompts)
1. **role_org**: Title + seniority + employer + functions
2. **location_rules**: Location + work mode + languages + availability
3. **requirements**: YOE + education + certifications + team scope
4. **success_signals**: Hard skills + key outcomes + industry hints

---

## 🚦 Integration Notes

### Frontend Integration
- **Upload Flow**: Upload → get `resumeId` → store for future use
- **Overview Flow**: Use `resumeId` → get comprehensive structured data (cached)
- **JD Flow**: Send JD text → get `jdHash` → use hash for future retrieval
- **Query Flow**: Use `resumeId` → ask custom questions
- **Error Handling**: Check `error.code` for specific error types

### Performance
- **Upload**: 5-15 seconds (depends on file size and AI processing)
- **Overview**: 3-8 seconds first time, <100ms cached (7 parallel AI calls)
- **JD Parsing**: 2-5 seconds first time, <100ms cached (4 parallel AI calls)
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

# 2. Generate overview (cached after first run)
curl -X POST http://localhost:8787/v1/overview \
  -d '{"resumeId": "uuid"}'
# Returns: comprehensive structured data

# 3. Ask custom questions
curl -X POST http://localhost:8787/v1/query \
  -d '{"resumeId": "uuid", "question": "What are the key achievements?"}'
```

### 2. Job Description Processing Pipeline
```bash
# 1. Parse JD
curl -X POST http://localhost:8787/v1/jd \
  -H "Content-Type: application/json" \
  -d '{"jdText": "Senior Developer..."}'
# Returns: { "jdHash": "a1b2c3d4...", "jd": {...} }

# 2. Retrieve cached JD (instant)
curl http://localhost:8787/v1/jd/a1b2c3d4...

# 3. List all cached JDs
curl http://localhost:8787/v1/jd
```

### 3. Batch Processing
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
- **"JD not found"**: Parse the JD first, then use the returned `jdHash`
- **Processing errors**: Check OpenAI API key and model availability
- **Storage persistence**: Ensure write permissions for `resume-storage.json`

### Debug Information
- Check server logs for detailed error messages
- Verify OpenAI API key is valid and has credits
- Confirm file uploads are under 10MB limit
- Check cache status in metadata (cached: true/false)

---

## 🔮 Future Enhancements

- **Database Integration**: Replace file storage with PostgreSQL/MongoDB
- **Batch Processing**: Process multiple resumes simultaneously
- **Advanced Analytics**: Skills matching, job fit scoring between resumes and JDs
- **Webhook Support**: Notify frontend of processing completion
- **Redis Integration**: Enhanced caching layer for production
- **Multi-language Support**: Enhanced language detection and processing
- **Resume-JD Matching**: AI-powered candidate-job matching algorithms
