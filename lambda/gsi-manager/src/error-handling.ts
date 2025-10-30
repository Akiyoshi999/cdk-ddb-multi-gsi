// Shared exponential backoff helper used to wrap AWS SDK calls.
import { randomInt } from "node:crypto";
import type { ErrorHandlingConfig } from "../../../lib/types/index.js";

const DEFAULT_JITTER_RATIO = 0.2;

const getErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const code = (error as { code?: string }).code;
  if (typeof code === "string" && code.length > 0) {
    return code;
  }

  const name = (error as { name?: string }).name;
  if (typeof name === "string" && name.length > 0) {
    return name;
  }

  return undefined;
};

const shouldRetry = (
  error: unknown,
  config: ErrorHandlingConfig,
  customRetryRule?: (err: unknown) => boolean
): boolean => {
  if (customRetryRule) {
    return customRetryRule(error);
  }

  const code = getErrorCode(error);
  if (!code) {
    return false;
  }

  return config.retryableErrorCodes.includes(code);
};

const sleep = async (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const addJitter = (baseDelay: number): number => {
  const jitterRange = Math.floor(baseDelay * DEFAULT_JITTER_RATIO);
  if (jitterRange === 0) {
    return baseDelay;
  }

  const jitter = randomInt(0, jitterRange);
  return baseDelay + jitter;
};

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  config: ErrorHandlingConfig,
  customRetryRule?: (err: unknown) => boolean
): Promise<T> {
  let attempt = 0;
  let delay = config.baseDelayMs;
  let lastError: unknown;

  while (attempt <= config.maxRetries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (
        attempt === config.maxRetries ||
        !shouldRetry(error, config, customRetryRule)
      ) {
        break;
      }

      await sleep(addJitter(Math.min(delay, config.maxDelayMs)));
      delay = Math.min(delay * 2, config.maxDelayMs);
      attempt += 1;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Operation failed after retries");
}
