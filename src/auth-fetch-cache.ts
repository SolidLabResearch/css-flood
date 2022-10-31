import fetch from "node-fetch";
import { createUserToken, getUserAuthFetch, UserToken } from "./solid-auth.js";

export class AuthFetchCache {
  cssBaseUrl: string;
  authenticateCache: "none" | "token" | "all" = "none";
  authenticate: boolean = false;

  cssTokensByUser: Array<UserToken | null> = [];
  authFetchersByUser: Array<typeof fetch | null> = [];

  useCount: number = 0;
  tokenFetchCount: number = 0;
  authFetchCount: number = 0;

  constructor(
    cssBaseUrl: string,
    authenticate: boolean,
    authenticateCache: "none" | "token" | "all"
  ) {
    this.cssBaseUrl = cssBaseUrl;
    this.authenticate = authenticate;
    this.authenticateCache = authenticateCache;
  }

  async getAuthFetcher(userId: number): Promise<typeof fetch> {
    this.useCount++;
    if (!this.authenticate) {
      return fetch;
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
      token = await createUserToken(this.cssBaseUrl, account, "password");
      this.tokenFetchCount++;
    }
    if (!theFetch) {
      theFetch = await getUserAuthFetch(this.cssBaseUrl, account, token);
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
    for (let userIndex = 0; userIndex < userCount; userIndex++) {
      this.authFetchersByUser[userIndex] = null;

      const account = `user${userIndex}`;

      if (this.authenticateCache !== "none") {
        const token = await createUserToken(
          this.cssBaseUrl,
          account,
          "password"
        );
        this.cssTokensByUser[userIndex] = token;
        this.tokenFetchCount++;

        if (this.authenticateCache === "all") {
          const fetch = await getUserAuthFetch(this.cssBaseUrl, account, token);
          this.authFetchersByUser[userIndex] = fetch;
          this.authFetchCount++;
        }
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
