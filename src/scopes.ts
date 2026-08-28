// Gmail and People API OAuth2 scope definitions and helpers
//
// Gmail scope hierarchy (for reference):
//   - gmail.readonly: Read-only access to emails
//   - gmail.modify: Read AND write access (superset of readonly)
//   - gmail.compose: Create drafts and send emails
//   - gmail.send: Send emails only
//   - gmail.labels: Manage labels only
//   - gmail.settings.basic: Manage filters and settings
//
// Note: gmail.modify includes all capabilities of gmail.readonly,
// so you don't need both scopes together.
//
// People API scopes (used by search_contacts and get_contact_photo):
//   - contacts.readonly: Read the user's saved contacts
//   - contacts.other.readonly: Read "other contacts", the addresses the user has
//     emailed but never saved as a contact
//   - directory.readonly: Read the Workspace domain directory (colleagues)
//
// These three are independent of each other and of the Gmail scopes: each one
// only unlocks its own People API source, and any of them can be missing without
// breaking the others.

// Map shorthand scope names to full Google API URLs
export const SCOPE_MAP: Record<string, string> = {
  "gmail.readonly": "https://www.googleapis.com/auth/gmail.readonly",
  "gmail.modify": "https://www.googleapis.com/auth/gmail.modify",
  "gmail.compose": "https://www.googleapis.com/auth/gmail.compose",
  "gmail.send": "https://www.googleapis.com/auth/gmail.send",
  "gmail.labels": "https://www.googleapis.com/auth/gmail.labels",
  "gmail.settings.basic": "https://www.googleapis.com/auth/gmail.settings.basic",
  "gmail.settings.sharing": "https://www.googleapis.com/auth/gmail.settings.sharing",
  "contacts.readonly": "https://www.googleapis.com/auth/contacts.readonly",
  "contacts.other.readonly": "https://www.googleapis.com/auth/contacts.other.readonly",
  "directory.readonly": "https://www.googleapis.com/auth/directory.readonly",
};

// Reverse map for converting full URLs back to shorthand
export const SCOPE_REVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SCOPE_MAP).map(([short, full]) => [full, short])
);

// Default scopes (original Gmail behavior plus read-only People lookup)
export const DEFAULT_SCOPES = [
  "gmail.modify",
  "gmail.settings.basic",
  "contacts.readonly",
  "contacts.other.readonly",
  "directory.readonly",
];

// Convert shorthand scope name to full Google API URL
// e.g., "gmail.readonly" -> "https://www.googleapis.com/auth/gmail.readonly"
export function scopeNameToUrl(scope: string): string {
  return SCOPE_MAP[scope] || scope;
}

// Convert full Google API URL to shorthand name
// e.g., "https://www.googleapis.com/auth/gmail.readonly" -> "gmail.readonly"
export function scopeUrlToName(scope: string): string {
  return SCOPE_REVERSE_MAP[scope] || scope;
}

// Convert array of shorthand scope names to full Google API URLs
export function scopeNamesToUrls(scopes: string[]): string[] {
  return scopes.map(scopeNameToUrl);
}

// Check if the authorized scopes grant access to a tool
// Returns true if ANY of the tool's required scopes are present in authorizedScopes
export function hasScope(authorizedScopes: string[], requiredScopes: string[]): boolean {
  // Normalize to shorthand names for comparison (handles both URL and shorthand input)
  const normalizedAuth = authorizedScopes.map(scopeUrlToName);
  return requiredScopes.some(scope => normalizedAuth.includes(scope));
}

// Parse scope input from CLI (comma-separated or space-separated)
export function parseScopes(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// Validate that all scopes are recognized
export function validateScopes(scopes: string[]): { valid: boolean; invalid: string[] } {
  const invalid = scopes.filter(s => !SCOPE_MAP[s]);
  return { valid: invalid.length === 0, invalid };
}

// Get available scope names for help text
export function getAvailableScopeNames(): string[] {
  return Object.keys(SCOPE_MAP);
}
