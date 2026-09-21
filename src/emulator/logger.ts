/**
 * Deduplicated, rate-limited logger for PS1 emulator errors and anomalies.
 * Limits repeated identical warning/error messages to at most 3 times.
 */

const logCounts = new Map<string, number>();

export function rateLimitLog(
  key: string,
  level: 'warn' | 'error' | 'info',
  message: string,
  maxCount: number = 3
): boolean {
  const count = (logCounts.get(key) || 0) + 1;
  logCounts.set(key, count);

  if (count <= maxCount) {
    const suffix = count === maxCount ? ' (further logs suppressed)' : '';
    const fullMsg = message + suffix;
    if (level === 'error') {
      console.error(fullMsg);
    } else if (level === 'warn') {
      console.warn(fullMsg);
    } else {
      console.log(fullMsg);
    }
    return true;
  }
  return false;
}

export function logWarnRateLimited(keyOrMessage: string, message?: string, maxCount: number = 3): boolean {
  const key = keyOrMessage;
  const msg = message !== undefined ? message : keyOrMessage;
  return rateLimitLog(key, 'warn', msg, maxCount);
}

export function logErrorRateLimited(keyOrMessage: string, message?: string, maxCount: number = 3): boolean {
  const key = keyOrMessage;
  const msg = message !== undefined ? message : keyOrMessage;
  return rateLimitLog(key, 'error', msg, maxCount);
}

export function clearLogRateLimits(): void {
  logCounts.clear();
}
