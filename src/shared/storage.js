import fs from 'fs/promises';
import path from 'path';

// Storage file path
const STORAGE_FILE = './resume-storage.json';

// Shared resume storage with file persistence
export const resumeStorage = new Map();

// Load resumes from disk on startup
async function loadFromDisk() {
  try {
    const data = await fs.readFile(STORAGE_FILE, 'utf8');
    const stored = JSON.parse(data);
    
    // Clear and reload the Map
    resumeStorage.clear();
    for (const [key, value] of Object.entries(stored)) {
      resumeStorage.set(key, value);
    }
    
    console.log(`📁 Loaded ${resumeStorage.size} resumes from disk`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('📁 No existing storage file found, starting fresh');
    } else {
      console.warn('⚠️ Failed to load storage from disk:', error.message);
    }
  }
}

// Save resumes to disk
async function saveToDisk() {
  try {
    const data = Object.fromEntries(resumeStorage);
    await fs.writeFile(STORAGE_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 Saved ${resumeStorage.size} resumes to disk`);
  } catch (error) {
    console.error('❌ Failed to save storage to disk:', error.message);
  }
}

// Initialize storage on module load
loadFromDisk();

// Helper functions for storage operations
export function storeResume(resumeId, resumeData) {
  resumeStorage.set(resumeId, resumeData);
  console.log(`✅ Resume stored: ${resumeId}, total: ${resumeStorage.size}`);
  
  // Auto-save to disk
  saveToDisk();
}

export function getResume(resumeId) {
  return resumeStorage.get(resumeId);
}

export function getAllResumeIds() {
  return Array.from(resumeStorage.keys());
}

export function getStorageSize() {
  return resumeStorage.size;
}

// Store overview data for a resume (caching)
export function storeOverview(resumeId, overviewData) {
  const resumeData = resumeStorage.get(resumeId);
  if (resumeData) {
    resumeData.overview = overviewData;
    resumeData.overviewTimestamp = new Date().toISOString();
    resumeStorage.set(resumeId, resumeData);
    console.log(`✅ Overview cached for: ${resumeId}`);
    
    // Auto-save to disk
    saveToDisk();
  } else {
    console.warn(`⚠️ Cannot cache overview: resume ${resumeId} not found`);
  }
}

// Check if overview is cached and fresh (within 24 hours)
export function hasFreshOverview(resumeId) {
  const resumeData = resumeStorage.get(resumeId);
  if (!resumeData || !resumeData.overview || !resumeData.overviewTimestamp) {
    return false;
  }
  
  const overviewAge = Date.now() - new Date(resumeData.overviewTimestamp).getTime();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  
  return overviewAge < maxAge;
}

// Manual save function (for explicit saves)
export async function persistStorage() {
  await saveToDisk();
}

// JD storage functions
export function storeJD(jdHash, jdData) {
  let jdStorage = resumeStorage.get('jd_cache');

  // Normalize to plain object for safe JSON persistence
  if (jdStorage instanceof Map) {
    jdStorage = Object.fromEntries(jdStorage);
  }
  if (!jdStorage || typeof jdStorage !== 'object') {
    jdStorage = {};
  }

  jdStorage[jdHash] = {
    ...jdData,
    timestamp: new Date().toISOString()
  };
  resumeStorage.set('jd_cache', jdStorage);
  console.log(`✅ JD cached for hash: ${jdHash}`);
  
  // Auto-save to disk
  saveToDisk();
}

export function getJD(jdHash) {
  const jdStorage = resumeStorage.get('jd_cache');
  if (!jdStorage) return null;
  if (jdStorage instanceof Map) return jdStorage.get(jdHash) || null;
  if (typeof jdStorage === 'object') return jdStorage[jdHash] || null;
  return null;
}

export function hasFreshJD(jdHash) {
  const jdData = getJD(jdHash);
  if (!jdData || !jdData.timestamp) {
    return false;
  }
  
  const jdAge = Date.now() - new Date(jdData.timestamp).getTime();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  
  return jdAge < maxAge;
}

export function getAllJDHashes() {
  const jdStorage = resumeStorage.get('jd_cache');
  if (!jdStorage) return [];
  if (jdStorage instanceof Map) return Array.from(jdStorage.keys());
  if (typeof jdStorage === 'object') return Object.keys(jdStorage);
  return [];
}

export function getJDStorageSize() {
  const jdStorage = resumeStorage.get('jd_cache');
  if (!jdStorage) return 0;
  if (jdStorage instanceof Map) return jdStorage.size;
  if (typeof jdStorage === 'object') return Object.keys(jdStorage).length;
  return 0;
}
