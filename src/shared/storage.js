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

// Manual save function (for explicit saves)
export async function persistStorage() {
  await saveToDisk();
}
