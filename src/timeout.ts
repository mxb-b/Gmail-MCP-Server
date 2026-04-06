/**
 * Timeout wrapper for Gmail API calls.
 * Prevents unbounded awaits from hanging the server indefinitely.
 */

export const DEFAULT_TIMEOUT_MS = 30_000;

export function withTimeout<T = any>(promise: Promise<T>, ms: number = DEFAULT_TIMEOUT_MS, label?: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`Request timed out after ${ms}ms${label ? `: ${label}` : ''}`));
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
