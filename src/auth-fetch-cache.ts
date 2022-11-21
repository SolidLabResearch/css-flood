import {
  AccessToken,
  createUserToken,
  getUserAuthFetch,
  stillUsableAccessToken,
  UserToken,
} from "./solid-auth.js";
import {
  AnyFetchResponseType,
  AnyFetchType,
  es6fetch,
} from "./generic-fetch.js";
import { DurationCounter } from "./duration-counter.js";
import { promises as fs } from "fs";

export class AuthFetchCache {
  cssBaseUrl: string;
  authenticateCache: "none" | "token" | "all" = "none";
  authenticate: boolean = false;

  cssTokensByUser: Array<UserToken | null> = [];
  authAccessTokenByUser: Array<AccessToken | null> = [];
  authFetchersByUser: Array<AnyFetchType | null> = [];

  useCount: number = 0;
  tokenFetchCount: number = 0;
  authFetchCount: number = 0;

  tokenFetchDuration = new DurationCounter();
  authAccessTokenDuration = new DurationCounter();
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
    let userToken = null;
    let accessToken = null;
    let theFetch = null;
    if (this.authenticateCache !== "none") {
      if (this.cssTokensByUser[userId]) {
        userToken = this.cssTokensByUser[userId];
      }
      if (this.authenticateCache === "all") {
        if (this.authAccessTokenByUser[userId]) {
          accessToken = this.authAccessTokenByUser[userId];
        }
        if (this.authFetchersByUser[userId]) {
          theFetch = this.authFetchersByUser[userId];
        }
      }
    }

    if (!userToken) {
      userToken = await createUserToken(
        this.cssBaseUrl,
        account,
        "password",
        this.fetcher,
        this.tokenFetchDuration
      );
      this.tokenFetchCount++;
    }
    if (!theFetch) {
      [theFetch, accessToken] = await getUserAuthFetch(
        this.cssBaseUrl,
        account,
        userToken,
        this.fetcher,
        this.authAccessTokenDuration,
        this.authFetchDuration,
        accessToken
      );
      this.authFetchCount++;
    }

    if (this.authenticateCache !== "none" && !this.cssTokensByUser[userId]) {
      this.cssTokensByUser[userId] = userToken;
    }
    if (
      this.authenticateCache === "all" &&
      !this.authAccessTokenByUser[userId]
    ) {
      this.authAccessTokenByUser[userId] = accessToken;
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
      let token = this.cssTokensByUser[userIndex];
      if (!token) {
        token = await createUserToken(
          this.cssBaseUrl,
          account,
          "password",
          this.fetcher,
          this.tokenFetchDuration
        );
        this.cssTokensByUser[userIndex] = token;
        this.tokenFetchCount++;
      }

      if (this.authenticateCache === "all") {
        const [fetch, accessToken] = await getUserAuthFetch(
          this.cssBaseUrl,
          account,
          token,
          this.fetcher,
          this.authAccessTokenDuration,
          this.authFetchDuration,
          this.authAccessTokenByUser[userIndex]
        );
        this.authAccessTokenByUser[userIndex] = accessToken;
        this.authFetchersByUser[userIndex] = fetch;
        this.authFetchCount++;
      }
    }
  }

  validate(userCount: number) {
    if (this.authenticateCache === "none") {
      return;
    }

    console.log(
      `Validating cache of ${userCount} user logins (cache method="${this.authenticateCache}")...`
    );

    const now = new Date();
    let allValid = true;
    for (let userIndex = 0; userIndex < userCount; userIndex++) {
      this.authFetchersByUser[userIndex] = null;
      const account = `user${userIndex}`;

      const token = this.cssTokensByUser[userIndex];
      if (!token) {
        console.warn(`   No user token for ${account}`);
        allValid = false;
      }

      const accessToken = this.authAccessTokenByUser[userIndex];
      if (this.authenticateCache === "all" && !accessToken) {
        console.warn(`   No access token for ${account}`);
        allValid = false;
      }

      if (
        this.authenticateCache === "all" &&
        accessToken &&
        !stillUsableAccessToken(accessToken)
      ) {
        const secondExpired =
          (now.getTime() - accessToken.expire.getTime()) / 1000.0;
        console.warn(
          `   No usable access token for ${account}. \n` +
            `      expiration=${accessToken.expire} \n` +
            `      now=${now} \n` +
            `      secondExpired=${secondExpired}`
        );
        allValid = false;
      }
    }
    if (!allValid) {
      console.error("Cache validation failed. Exiting.");
      process.exit(1);
    } else {
      console.log(`    ... all valid!`);
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

  toCountString(): string {
    return `${this.cssTokensByUser.length} userTokens and ${this.authAccessTokenByUser.length} authAccessTokens`;
  }

  async save(authCacheFile: string) {
    const accessTokenForJson = [...this.authAccessTokenByUser].map(
      (accessToken) =>
        !accessToken
          ? null
          : { token: accessToken.token, expire: accessToken.expire.getTime() }
    );
    const c = {
      cssTokensByUser: this.cssTokensByUser,
      authAccessTokenByUser: accessTokenForJson,
    };
    const cacheContent = JSON.stringify(c);
    await fs.writeFile(authCacheFile, cacheContent);
  }

  async load(authCacheFile: string) {
    const cacheContent = await fs.readFile(authCacheFile, "utf-8");
    const c = JSON.parse(cacheContent);
    this.cssTokensByUser = c.cssTokensByUser;
    this.authAccessTokenByUser = c.authAccessTokenByUser;
    for (const accessToken of this.authAccessTokenByUser.values()) {
      if (accessToken) {
        //because we got if from JSON, accessToken.expire will be a string, not a Date!
        // @ts-ignore
        if (typeof accessToken === "number") {
          // @ts-ignore
          const expireLong: number = accessToken.expire;
          // @ts-ignore
          accessToken.expire = new Date(expireLong);
        } else {
          console.error(
            `AccessToken in JSON has expire of unexpected type (${typeof accessToken.expire}) value=${
              accessToken.expire
            }`
          );
        }
      }
    }
  }
}
