// What a failed write is allowed to say on the screen.
//
// A Convex error carries the server's own stack — function name, request id,
// file and line — and that is a developer's message, not a driver's. On a
// wall screen it is worse than useless: it is unreadable at three metres and
// it names the inside of the building. So the garages show one of two
// sentences instead, picked from what actually went wrong, and the detail
// goes to the console where it belongs.

/** The server's refusal when nobody is signed in — see convex/me.ts. */
const NOT_AUTHENTICATED = /not authenticated/i

/**
 * A sentence to put on the control bar when a save fails.
 *
 * @param cause The rejection from the mutation.
 * @param noun What could not be saved, in the garage's own language — "car",
 *   "fighter", "plane". Used only in the fallback sentence.
 */
export function saveErrorMessage(cause: unknown, noun: string): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  if (NOT_AUTHENTICATED.test(detail)) {
    return 'Sign in from Account to save — this screen is watching, not driving.'
  }
  return `Could not save your ${noun}. Try again.`
}
