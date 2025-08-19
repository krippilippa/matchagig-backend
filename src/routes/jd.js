import { parseAndCacheJD } from '../lib/jd-parser.js';
import { getJD, hasFreshJD, getJDStorageSize, getAllJDHashes } from '../shared/storage.js';

export default async function jdRoute(app) {
  // GET endpoint to retrieve cached JD results
  app.get('/v1/jd/:jdHash', async (req, reply) => {
    try {
      const { jdHash } = req.params;
      
      if (!jdHash) {
        return reply.code(400).send(err('BAD_REQUEST', 'Required: jdHash parameter'));
      }

      const jdData = getJD(jdHash);
      
      if (!jdData) {
        return reply.code(404).send(err('NOT_FOUND', 'JD not found in cache'));
      }

      return reply.send({
        jdHash,
        jd: jdData.jd,
        metadata: {
          ...jdData.metadata,
          cached: true,
          retrievedAt: new Date().toISOString()
        }
      });

    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('JD_GET_ERROR', 'Failed to retrieve JD', { hint: e.message }));
    }
  });

  // GET endpoint to list all cached JDs
  app.get('/v1/jd', async (req, reply) => {
    try {
      const jdHashes = getAllJDHashes();
      const storageSize = getJDStorageSize();
      
      return reply.send({
        totalCached: storageSize,
        jdHashes,
        metadata: {
          timestamp: new Date().toISOString()
        }
      });

    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('JD_LIST_ERROR', 'Failed to list JDs', { hint: e.message }));
    }
  });

  app.post('/v1/jd', async (req, reply) => {
    if (!process.env.OPENAI_API_KEY) {
      return reply.code(500).send(err('CONFIG', 'OPENAI_API_KEY not set'));
    }

    try {
      const body = await req.body;
      const jdText = (body?.jdText || '').toString();

      if (!jdText) {
        return reply.code(400).send(err('BAD_REQUEST', 'Required: { jdText }'));
      }

      // Use the shared parser
      const { jdHash, jd, metadata } = await parseAndCacheJD(jdText);

      return reply.send({
        jdHash,
        jd,
        metadata
      });

    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('JD_ERROR', 'Failed to process job description', { hint: e.message }));
    }
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}


