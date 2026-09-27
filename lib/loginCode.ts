// The shape of a one-time sign-in code, shared by the server that mints it
// and the screen that accepts one typed from a phone or a terminal.

/** No 0/O or 1/I: the code is read off one screen and typed into another. */
export const LOGIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const LOGIN_CODE_LENGTH = 8
export const LOGIN_CODE_TTL_MS = 10 * 60_000

/** Uppercases and strips separators, so "abcd-efgh" and "ABCDEFGH" agree. */
export function normaliseLoginCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, LOGIN_CODE_LENGTH)
}
