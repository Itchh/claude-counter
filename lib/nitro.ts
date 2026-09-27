// The nitro bank: tokens burned while you are NOT driving become seconds of
// boost you can spend when you are. Shared by the server (which settles the
// bank when the wheel is taken) and the client (which drains it under the
// Space bar), so the two agree on what a second of nitro costs.

/** Seconds of boost one nitro bank can hold. */
export const NITRO_MAX_SECONDS = 20
/** Tokens that earn one second of boost. A hard day's work fills the bank. */
export const TOKENS_PER_NITRO_SECOND = 25_000
/** Speed multiplier while the boost is lit. */
export const NITRO_SPEED_MULTIPLIER = 1.28

/** Bank after crediting the tokens burned since the last settlement. */
export function settleNitro(
  charge: number,
  totalTokens: number,
  accountedTokens: number,
): number {
  const owed = Math.max(0, totalTokens - accountedTokens) / TOKENS_PER_NITRO_SECOND
  return Math.max(0, Math.min(NITRO_MAX_SECONDS, charge + owed))
}
