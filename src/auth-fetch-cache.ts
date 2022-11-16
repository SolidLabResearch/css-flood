import { createUserToken, getUserAuthFetch, UserToken } from "./solid-auth.js";
import {
  AnyFetchResponseType,
  AnyFetchType,
  es6fetch,
} from "./generic-fetch.js";
import { DurationCounter } from "./duration-counter.js";

export class AuthFetchCache {
  cssBaseUrl: string;
  authenticateCache: "none" | "token" | "all" = "none";
  authenticate: boolean = false;

  cssTokensByUser: Array<UserToken | null> = [];
  authFetchersByUser: Array<AnyFetchType | null> = [];

  useCount: number = 0;
  tokenFetchCount: number = 0;
  authFetchCount: number = 0;

  tokenFetchDuration = new DurationCounter();
  authFetchDuration = new DurationCounter();

  fetcher: AnyFetchType;

  constructor(
    cssBaseUrl: string,
    authenticate: boolean,
    authenticateCache: "none" | "token" | "all",
    fetcher: AnyFetchType = es6fetch
  ) {
    this.cssBaseUrl = cssBaseUrl;
    this.authenticate = authenticate;
    this.authenticateCache = authenticateCache;
    this.fetcher = fetcher;
  }

  async getAuthFetcher(userId: number): Promise<AnyFetchType> {
    this.useCount++;
    if (!this.authenticate) {
      return this.fetcher;
    }
    const account = `user${userId}`;
    let token = null;
    let theFetch = null;
    if (this.authenticateCache !== "none") {
      if (this.cssTokensByUser[userId]) {
        token = this.cssTokensByUser[userId];
      }
      if (this.authenticateCache === "all") {
        if (this.authFetchersByUser[userId]) {
          theFetch = this.authFetchersByUser[userId];
        }
      }
    }

    if (!token) {
      token = await createUserToken(
        this.cssBaseUrl,
        account,
        "password",
        this.fetcher,
        this.tokenFetchDuration
      );
      this.tokenFetchCount++;
    }
    if (!theFetch) {
      theFetch = await getUserAuthFetch(
        this.cssBaseUrl,
        account,
        token,
        this.fetcher,
        this.authFetchDuration
      );
      this.authFetchCount++;
    }

    if (this.authenticateCache !== "none" && !this.cssTokensByUser[userId]) {
      this.cssTokensByUser[userId] = token;
    }
    if (this.authenticateCache === "all" && !this.authFetchersByUser[userId]) {
      this.authFetchersByUser[userId] = theFetch;
    }

    return theFetch;
  }

  async preCache(userCount: number) {
    if (this.authenticateCache === "none") {
      return;
    }

    console.log(
      `Caching ${userCount} user logins (cache method="${this.authenticateCache}")...`
    );

    for (let userIndex = 0; userIndex < userCount; userIndex++) {
      this.authFetchersByUser[userIndex] = null;

      const account = `user${userIndex}`;

      console.log(`   Pre-cache is authenticating user ${userIndex}...`);
      const token = await createUserToken(
        this.cssBaseUrl,
        account,
        "password",
        this.fetcher,
        this.tokenFetchDuration
      );
      this.cssTokensByUser[userIndex] = token;
      this.tokenFetchCount++;

      if (this.authenticateCache === "all") {
        const fetch = await getUserAuthFetch(
          this.cssBaseUrl,
          account,
          token,
          this.fetcher,
          this.authFetchDuration
        );
        this.authFetchersByUser[userIndex] = fetch;
        this.authFetchCount++;
      }
    }
  }

  // cssBaseUrl: string;
  // authenticateCache: "none" | "token" | "all" = "none";
  // authenticate: boolean = false;
  //
  // cssTokensByUser: Array<UserToken | null> = [];
  // authFetchersByUser: Array<typeof fetch | null> = [];
  toString(): string {
    return `AuthFetchCache{
                cssBaseUrl=${this.cssBaseUrl}, 
                authenticateCache=${this.authenticateCache}, 
                authenticate=${this.authenticate}, 
                cssTokensByUser.length=${this.cssTokensByUser.length}, 
                authFetchersByUser.length=${this.authFetchersByUser.length}, 
                useCount=${this.useCount}, 
                tokenFetchCount=${this.tokenFetchCount}, 
                authFetchCount=${this.authFetchCount}
            }`;
  }
}
