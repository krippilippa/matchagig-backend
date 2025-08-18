// routes/bulk.js - Minimal test route for PDF text extraction

export default async function bulkRoutes(app) {
  // Simple test route - just extract text from one PDF
  app.post("/v1/bulk-test", async (req, reply) => {
    try {
      const body = await req.body;
      const base64 = body?.base64;
      
      if (!base64) {
        return reply.code(400).send({ 
          error: "Missing base64 data",
          message: "Send { base64: 'base64string' }" 
        });
      }

      console.log('🔍 Testing PDF text extraction...');
      
      // Convert base64 to buffer
      const buffer = Buffer.from(base64, 'base64');
      console.log(`📏 Buffer size: ${buffer.length} bytes`);
      
      // Try to extract text (lazy load to avoid initialization issues)
      const pdf = (await import('pdf-parse')).default;
      const data = await pdf(buffer);
      const text = data.text || '';
      
      console.log(`📝 Extracted text length: ${text.length}`);
      console.log(`📝 Text preview: ${text.substring(0, 200)}...`);
      
      return reply.send({
        success: true,
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
