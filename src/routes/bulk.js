// routes/bulk.js - Minimal test route for PDF text extraction
import { toFile } from 'openai';

export default async function bulkRoutes(app) {
  // Simple test route - upload PDF and extract text
  app.post("/v1/bulk-test", async (req, reply) => {
    try {
      const data = await req.file();
      
      if (!data) {
        return reply.code(400).send({ 
          error: "No file uploaded",
          message: "Upload a PDF file" 
        });
      }

      console.log('🔍 Testing PDF text extraction...');
      console.log(`📁 Filename: ${data.filename}`);
      console.log(`📏 File size: ${data.file.bytesRead} bytes`);
      
      // Convert the file to buffer
      const buffer = await data.toBuffer();
      console.log(`📏 Buffer size: ${buffer.length} bytes`);
      
      // Try to extract text (lazy load to avoid initialization issues)
      const pdf = (await import('pdf-parse')).default;
      const pdfData = await pdf(buffer);
      const text = pdfData.text || '';
      
      console.log(`📝 Extracted text length: ${text.length}`);
      console.log(`📝 Text preview: ${text.substring(0, 200)}...`);
      
      return reply.send({
        success: true,
        filename: data.filename,
        textLength: text.length,
        preview: text.substring(0, 500),
        fullText: text
      });
      
    } catch (e) {
      console.error('❌ PDF extraction failed:', e.message);
      return reply.code(500).send({ 
        error: "PDF extraction failed",
        message: e.message 
      });
    }
  });
}
