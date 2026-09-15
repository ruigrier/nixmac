import { useSyncExternalStore } from "react";

type RetryOperation = () => Promise<void>;

let revision = 0;
let retryOperation: RetryOperation | null = null;
const listeners = new Set<() => void>();

export function setRebuildRetry(operation: RetryOperation | null) {
  revision += 1;
  retryOperation = operation;
  for (const listener of listeners) listener();
}

/** Only the latest operation may publish a retry after asynchronous cleanup. */
export function beginRebuildRetry() {
  setRebuildRetry(null);
  const operationRevision = revision;
  return (operation: RetryOperation | null) => {
    if (revision === operationRevision) setRebuildRetry(operation);
  };
}

export async function retryLastRebuild() {
  const operation = retryOperation;
  if (!operation) return;
  // Consume before invoking: double clicks cannot start overlapping operations.
  setRebuildRetry(null);
  await operation();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCanRetryRebuild() {
  return useSyncExternalStore(
    subscribe,
    () => retryOperation !== null,
    () => false,
  );
}
