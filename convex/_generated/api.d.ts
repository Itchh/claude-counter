/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as control from "../control.js";
import type * as crons from "../crons.js";
import type * as debugCounts from "../debugCounts.js";
import type * as deviceLink from "../deviceLink.js";
import type * as hotlaps from "../hotlaps.js";
import type * as http from "../http.js";
import type * as leaderboard from "../leaderboard.js";
import type * as livery from "../livery.js";
import type * as me from "../me.js";
import type * as scoring from "../scoring.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  control: typeof control;
  crons: typeof crons;
  debugCounts: typeof debugCounts;
  deviceLink: typeof deviceLink;
  hotlaps: typeof hotlaps;
  http: typeof http;
  leaderboard: typeof leaderboard;
  livery: typeof livery;
  me: typeof me;
  scoring: typeof scoring;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
