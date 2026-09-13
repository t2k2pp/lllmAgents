/** Recognize provider rate limits without treating arbitrary successful output as an error. */
export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /rate[_ -]?limit|too many requests|(?:HTTP|status(?: code)?)\s*[:=]?\s*429\b/i.test(message);
}
