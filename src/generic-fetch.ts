import nodeFetch from "node-fetch";
import { Response as NodeFetchResponse } from "node-fetch";

export type AnyFetchType = typeof fetch | typeof nodeFetch;
export type AnyFetchResponseType = Response | NodeFetchResponse;

export const es6fetch = fetch;
