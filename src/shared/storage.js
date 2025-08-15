// Shared resume storage (replace with database in production)
export const resumeStorage = new Map();

// Helper functions for storage operations
export function storeResume(resumeId, resumeData) {
  resumeStorage.set(resumeId, resumeData);
  console.log(`✅ Resume stored: ${resumeId}, total: ${resumeStorage.size}`);
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
