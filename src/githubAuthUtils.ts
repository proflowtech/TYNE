// Pure GitHub-auth helpers (no vscode imports) so they are unit-testable.

// Raised when a Tyne backend call rejects the saved GitHub token (expired/revoked).
export class GitHubTokenInvalidError extends Error {
  constructor(message = 'Invalid GitHub token') {
    super(message);
    this.name = 'GitHubTokenInvalidError';
  }
}

// A 401 from an authenticated Tyne backend call means the saved GitHub token is no
// longer valid. We treat any 401 on these calls as an invalid session; when a body
// is present we still recognise the explicit backend messages.
export function isInvalidGitHubTokenResponse(status: number, bodyText?: string): boolean {
  if (status !== 401) { return false; }
  if (!bodyText) { return true; }
  return /invalid github token|unauthorized|expired|invalid token|reconnect github|sign in again|invalid auth token/i.test(bodyText);
}
