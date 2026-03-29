export function registerPendingThreadResume(pendingThreadResumes, threadId, promise) {
  if (!pendingThreadResumes || !threadId || !promise) return;
  pendingThreadResumes.set(threadId, promise);
  promise
    .finally(() => {
      if (pendingThreadResumes.get(threadId) === promise) {
        pendingThreadResumes.delete(threadId);
      }
    })
    .catch(() => {});
}

export async function waitPendingThreadResume(pendingThreadResumes, threadId) {
  if (!pendingThreadResumes || !threadId) return;
  const pending = pendingThreadResumes.get(threadId);
  if (!pending) return;
  try {
    await pending;
  } catch (_) {
  }
}
