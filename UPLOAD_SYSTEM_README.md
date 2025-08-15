# Canonical Resume Storage System

## Overview

The upload route has been rebuilt to implement a canonical resume storage system that ensures consistent, reliable text extraction and storage for all subsequent processing steps.

## Key Features

### 1. **Faithful Text Extraction**
- **Multi-format support**: PDF, DOCX, TXT files
- **Parser-first approach**: Uses native parsers (pdf-parse, mammoth) for reliable extraction
- **LLM fallback**: Falls back to GPT-5-nano if parsers fail
- **Text normalization**: Fixes hyphenation, multi-column issues, excessive whitespace

### 2. **Canonical Storage**
- **Unique identification**: Each resume gets a UUID (`resumeId`)
- **Structured metadata**: Stores name, email, canonical text, upload timestamp
- **Consistent access**: All micro-prompts use the same canonical text

### 3. **Strict Validation**
- **JSON schema validation**: Uses Zod to ensure output integrity
- **No extra fields**: Strict schema prevents additional properties
- **Retry mechanism**: Automatically retries failed JSON parsing

### 4. **GPT-5-nano Integration**
- **Optimized model**: Uses GPT-5-nano for cost-effective processing
- **Structured prompts**: Embedded system messages ensure consistent output
- **Error handling**: Graceful fallback and retry logic

## API Endpoints

### POST `/v1/upload`
Upload a resume and get a canonical ID.

**Request**: Multipart form data with resume file
**Response**:
```json
{
  "resumeId": "uuid-string",
  "name": "John Doe",
  "email": "john@example.com",
  "length": 1234
}
```

**Supported formats**: PDF, DOCX, TXT
**File size limit**: 10MB

### GET `/v1/resume/:resumeId`
Retrieve canonical resume data.

**Response**:
```json
{
  "resumeId": "uuid-string",
  "name": "John Doe",
  "email": "john@example.com",
  "canonicalText": "Full extracted text...",
  "uploadedAt": 1703123456789
}
```

### POST `/v1/query` (Updated)
Query resume using canonical text.

**Request**:
```json
{
  "resumeId": "uuid-string",
  "question": "What are the candidate's skills?"
}
```

**Response**:
```json
{
  "text": "Answer based on canonical text...",
  "resumeId": "uuid-string",
  "question": "What are the candidate's skills?",
  "textLength": 1234
}
```

## Text Processing Pipeline

### 1. **File Upload & Validation**
- Accept multipart form data
- Validate file type and size
- Generate unique `resumeId`

### 2. **Text Extraction**
- **Primary**: Use native parsers (pdf-parse, mammoth)
- **Fallback**: GPT-5-nano if parsers fail
- **Normalization**: Clean up common formatting issues

### 3. **Structured Processing**
- Send to GPT-5-nano with embedded system prompt
- Extract name, email, and canonical text
- Validate JSON output with Zod schema

### 4. **Storage & Retrieval**
- Store in canonical format
- Provide access endpoints
- Enable micro-prompt integration

## System Prompt (Embedded)

The system prompt is embedded in the code and ensures consistent output:

```
You are a résumé text extractor. Read the attached file and OUTPUT ONLY valid JSON with this exact schema:
{
  "name": string|null,
  "email": string|null,
  "text": string
}
Rules:
- name: full candidate name if clearly stated; else null.
- email: primary email if present; else null.
- text: faithful plain-text extraction of the document content.
Text extraction rules:
- Preserve all wording, punctuation, capitalization, numbers, names, and dates.
- Allowed cleanup: fix hyphenated line breaks; merge multi-column order; remove repeated headers/footers/page numbers; collapse excessive whitespace while keeping paragraph/list structure.
- Do NOT summarize, paraphrase, or infer content.
Output JSON only. No markdown, no extra keys, no comments.
```

## Integration Pattern

### For Micro-Prompts
All parsing requests should:

1. **Accept `resumeId`** instead of file uploads
2. **Fetch canonical text** from storage
3. **Use relevant snippets** or full text in prompts
4. **Ensure consistency** across all processing steps

### Example Integration
```javascript
// Instead of re-uploading files
const resumeData = resumeStorage.get(resumeId);
const { canonicalText, name, email } = resumeData;

// Use canonical text directly
const prompt = `Process this resume text: ${canonicalText}`;
```

## Benefits

### 1. **Consistency**
- Same text input for all processing steps
- No variation from multiple uploads
- Reliable metadata extraction

### 2. **Efficiency**
- No repeated file processing
- Faster micro-prompt execution
- Reduced API costs

### 3. **Reliability**
- Structured validation prevents errors
- Fallback mechanisms ensure success
- Clear error handling

### 4. **Scalability**
- Easy to add new micro-prompts
- Centralized storage management
- Simple database migration path

## Production Considerations

### Storage
- **Current**: In-memory Map (development only)
- **Production**: PostgreSQL, MongoDB, or Redis
- **Persistence**: Ensure data survives restarts

### Security
- **Authentication**: Add user authentication
- **Authorization**: Control access to resumes
- **Rate limiting**: Prevent abuse

### Monitoring
- **Health checks**: Monitor system status
- **Logging**: Track processing metrics
- **Error tracking**: Monitor failure rates

## Testing

Run the test script to verify functionality:
```bash
node test-upload.js
```

Start the server:
```bash
npm run dev
```

## Dependencies

- `uuid`: Generate unique resume IDs
- `zod`: JSON schema validation
- `pdf-parse`: PDF text extraction
- `mammoth`: DOCX text extraction
- `openai`: GPT-5-nano integration

## Future Enhancements

1. **Database integration** for persistent storage
2. **File cleanup** for temporary uploads
3. **Caching layer** for performance
4. **Batch processing** for multiple resumes
5. **Version control** for resume updates
6. **Analytics** for processing metrics
