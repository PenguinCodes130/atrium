// Every sentence the favicon fetch answers with (architecture A11.6; operator-tryout-spec N4: "failure
// says why in words"). Pure, so the picker and the tests read the same words the route sends.

export const FAVICON_MAX_PAGE_BYTES = 512 * 1024;
export const FAVICON_MAX_ICON_BYTES = 1024 * 1024;
export const FAVICON_MAX_PX = 256;
export const FAVICON_TIMEOUT_MS = 5_000;
export const FAVICON_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
export const FAVICON_MAX_URL = 2048;
/** Fetches (not cache answers) one person may start per minute. */
export const FAVICON_RATE_PER_MIN = 30;

export const FAVICON_MESSAGES = {
  typeAddress: "Type a website address, such as https://example.com.",
  tooLong: "That address is too long.",
  scheme: "Only http and https addresses can be used.",
  credentials: "Take the user name and password out of the address.",
  forbidden: "Only owners and members can fetch website icons. An agent also needs the atrium:edit scope.",
  refused: "Atrium will not fetch from that address. It is, or redirects to, a link-local or cloud metadata address.",
  privateFromPublic: "That website pointed Atrium at an address on your network, which a public website is not allowed to do.",
  publicFromPrivate: "That address is on your network but sent Atrium to an address outside it, which Atrium does not follow for icons.",
  mixedAnswer: "That website's address also points at a machine on your network, so Atrium will not read it.",
  none: "That website has no icon Atrium can use. Pick one from the grid, or upload one.",
  tooLarge: "That website's icon is larger than 1 MB. Pick one from the grid, or upload one.",
  pageTooLarge: "That website's page is larger than 512 KB and it has no /favicon.ico, so Atrium found no icon. Pick one from the grid, or upload one.",
  tooManyPx: "That website's icons are all larger than 256 px. Pick one from the grid, or upload one.",
  rateLimited: "Too many icon fetches. Try again in a minute.",
  unreachable: "That website could not be reached. Check the address.",
  redirects: "That website redirected more than 3 times, so Atrium stopped.",
  certificate: "That website's certificate is not trusted, so Atrium did not read it.",
  timeout: "That website did not answer within 5 seconds.",
} as const;

export type FaviconMessageKey = keyof typeof FAVICON_MESSAGES;
