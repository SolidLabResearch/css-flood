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
import * as jose from "jose";

export function fromNow(d?: Date | null): null | string {
  if (!d) {
    return null;
  }
  const now = new Date();
  const s = (d.getTime() - now.getTime()) / 1000;
  if (s > 0) {
    return `in ${s}s`;
  } else {
    return `${-s}s ago`;
  }
}

export interface AuthFetchCacheStats {
  cssBaseUrl: string;
  authenticateCache: "none" | "token" | "all";
  authenticate: boolean;
  lenCssTokensByUser: number;
  lenAuthAccessTokenByUser: number;
  lenAuthFetchersByUser: number;
  useCount: number;
  tokenFetchCount: number;
  authFetchCount: number;
}

export class AuthFetchCache {
  cssBaseUrl: string;
  authenticateCache: "none" | "token" | "all" = "none";
  authenticate: boolean = false;

  cssTokensByUser: Array<UserToken | null> = [];
  authAccessTokenByUser: Array<AccessToken | null> = [];
  authFetchersByUser: Array<AnyFetchType | null> = [];
  loadedAuthCacheMeta: Object = {};

  useCount: number = 0;
  tokenFetchCount: number = 0;
  authFetchCount: number = 0;

  tokenFetchDuration = new DurationCounter();
  authAccessTokenDuration = new DurationCounter();
  authFetchDuration = new DurationCounter();
  generateDpopKeyPairDurationCounter = new DurationCounter();

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
        this.generateDpopKeyPairDurationCounter,
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

  async preCache(userCount: number, ensureAuthExpirationS: number) {
    if (this.authenticateCache === "none") {
      return;
    }

    let countUTFetch = 0;
    let countUTUseExisting = 0;
    let countATFetch = 0;
    let countATUseExisting = 0;
    let earliestATexpiration: Date | null = null;
    let earliestATUserIndex: number | null = null;
    let earliestATWasReused: boolean | null = null;
    let earliestATStillUsable: boolean | null = null;
    let earliestATPreviousAT: AccessToken | null = null;
    let earliestATCurAT: AccessToken | null = null;

    console.log(
      `Caching ${userCount} user logins (cache method="${this.authenticateCache}")...`
    );

    for (let userIndex = 0; userIndex < userCount; userIndex++) {
      this.authFetchersByUser[userIndex] = null;

      const account = `user${userIndex}`;

      process.stdout.write(
        `   Pre-cache is authenticating user ${
          userIndex + 1
        }/${userCount}...                                        \r`
      );
      let token = this.cssTokensByUser[userIndex];
      if (!token) {
        process.stdout.write(
          `   Pre-cache is authenticating user ${
            userIndex + 1
          }/${userCount}... fetching user token...\r`
        );
        token = await createUserToken(
          this.cssBaseUrl,
          account,
          "password",
          this.fetcher,
          this.tokenFetchDuration
        );
        this.cssTokensByUser[userIndex] = token;
        this.tokenFetchCount++;
        countUTFetch++;
      } else {
        countUTUseExisting++;
      }

      if (this.authenticateCache === "all") {
        const now = new Date();
        const curAccessToken = this.authAccessTokenByUser[userIndex];
        const atInfo = curAccessToken?.expire
          ? `(expires ${fromNow(curAccessToken?.expire)})`
          : `(none)`;
        process.stdout.write(
          `   Pre-cache is authenticating user ${
            userIndex + 1
          }/${userCount}... checking access token ${atInfo}...\r`
        );
        const [fetch, accessToken] = await getUserAuthFetch(
          this.cssBaseUrl,
          account,
          token,
          this.fetcher,
          this.authAccessTokenDuration,
          this.authFetchDuration,
          this.generateDpopKeyPairDurationCounter,
          this.authAccessTokenByUser[userIndex],
          ensureAuthExpirationS
        );
        const wasReused = this.authAccessTokenByUser[userIndex] == accessToken;
        if (!wasReused) {
          countATFetch++;
        } else {
          countATUseExisting++;
        }
        if (
          earliestATexpiration == null ||
          accessToken.expire.getTime() < earliestATexpiration.getTime()
        ) {
          earliestATexpiration = accessToken.expire;
          earliestATUserIndex = userIndex;
          earliestATWasReused = wasReused;
          earliestATStillUsable = stillUsableAccessToken(
            accessToken,
            ensureAuthExpirationS
          );
          earliestATCurAT = accessToken;
          earliestATPreviousAT = this.authAccessTokenByUser[userIndex];
        }
        this.authAccessTokenByUser[userIndex] = accessToken;
        this.authFetchersByUser[userIndex] = fetch;
        this.authFetchCount++;
      }
    }
    process.stdout.write(`\n`);
    console.log(`Precache done. Counts:`);
    console.log(
      `     UserToken fetch ${countUTFetch} reuse ${countUTUseExisting}`
    );
    console.log(
      `     AccessToken fetch ${countATFetch} reuse ${countATUseExisting}`
    );
    console.log(
      `     First AccessToken expiration: ${earliestATexpiration?.toISOString()}=${fromNow(
        earliestATexpiration
      )}` +
        ` (user ${earliestATUserIndex} reused=${earliestATWasReused} stillUsable=${earliestATStillUsable} ` +
        `ensureAuthExpirationS=${ensureAuthExpirationS} ` +
        `prevExpire=${earliestATPreviousAT?.expire.toISOString()}=${fromNow(
          earliestATPreviousAT?.expire
        )})`
    );

    console.assert(earliestATStillUsable);
  }

  validate(userCount: number, ensureAuthExpirationS: number) {
    if (this.authenticateCache === "none") {
      return;
    }

    console.log(
      `Validating cache of ${userCount} user logins (cache method="${this.authenticateCache}")...`
    );

    const now = new Date();
    let allValid = true;
    for (let userIndex = 0; userIndex < userCount; userIndex++) {
      process.stdout.write(
        `   Validating user ${userIndex + 1}/${userCount}...\r`
      );
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
        !stillUsableAccessToken(accessToken, ensureAuthExpirationS)
      ) {
        const secondUntilExpiration =
          (accessToken.expire.getTime() - now.getTime()) / 1000.0;
        console.warn(
          `   No usable access token for ${account}. \n` +
            `      expiration=${accessToken.expire} \n` +
            `             now=${now} \n` +
            `      secondUntilExpiration=${secondUntilExpiration}`
        );
        allValid = false;
      }
    }
    process.stdout.write(`\n`);
    if (!allValid) {
      console.error("Cache validation failed. Exiting.");
      process.exit(1);
    } else {
      console.log(`    ... all valid!`);
    }
  }

  async test(
    userCount: number,
    cssBaseUrl: string,
    filename: string,
    fetchTimeoutMs: number
  ) {
    console.log(
      `Testing ${userCount} user logins (authenticate=${this.authenticate} authenticateCache="${this.authenticateCache}")...`
    );

    let allSuccess = true;
    for (let userIndex = 0; userIndex < userCount; userIndex++) {
      const account = `user${userIndex}`;
      process.stdout.write(
        `   Testing user ${userIndex + 1}/${userCount}...\r`
      );
      try {
        const aFetch = await this.getAuthFetcher(userIndex);
        const res: AnyFetchResponseType = await aFetch(
          `${cssBaseUrl}${account}/${filename}`,
          {
            method: "GET",
            //open bug in nodejs typescript that AbortSignal.timeout doesn't work
            //  see https://github.com/node-fetch/node-fetch/issues/741
            // @ts-ignore
            signal: AbortSignal.timeout(fetchTimeoutMs), // abort after 4 seconds //supported in nodejs>=17.3
          }
        );
        if (!res.ok) {
          allSuccess = false;
          console.error(
            `         Authentication test failed for user ${userIndex}. HTTP status ${res.status}`
          );
          console.error(`            Error message: ${await res.text()}`);
        } else {
          const body = await res.text();
          if (!body) {
            console.error(
              `         Authentication test failed for user ${userIndex}: no body`
            );
            allSuccess = false;
          }
        }
      } catch (e) {
        allSuccess = false;
        console.error(
          `         Authentication test exception for user ${userIndex}`,
          e
        );
      }
    }
    process.stdout.write(`\n`);
    if (!allSuccess) {
      console.error("Authentication test failed. Exiting.");
      process.exit(1);
    } else {
      console.log(`    ... authentication test success!`);
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
                authAccessTokenByUser.length=${this.authAccessTokenByUser.length}, 
                authFetchersByUser.length=${this.authFetchersByUser.length}, 
                useCount=${this.useCount}, 
                tokenFetchCount=${this.tokenFetchCount}, 
                authFetchCount=${this.authFetchCount}
            }`;
  }

  toStatsObj(): AuthFetchCacheStats {
    return {
      cssBaseUrl: this.cssBaseUrl,
      authenticateCache: this.authenticateCache,
      authenticate: this.authenticate,
      lenCssTokensByUser: this.cssTokensByUser.length,
      lenAuthAccessTokenByUser: this.authAccessTokenByUser.length,
      lenAuthFetchersByUser: this.authFetchersByUser.length,
      useCount: this.useCount,
      tokenFetchCount: this.tokenFetchCount,
      authFetchCount: this.authFetchCount,
    };
  }

  toCountString(): string {
    return `${this.cssTokensByUser.length} userTokens and ${this.authAccessTokenByUser.length} authAccessTokens`;
  }

  async dump(): Promise<any> {
    const accessTokenForJson = await Promise.all(
      [...this.authAccessTokenByUser].map(async (accessToken) =>
        !accessToken
          ? null
          : {
              token: accessToken.token,
              expire: accessToken.expire.getTime(),
              dpopKeyPair: {
                publicKey: accessToken.dpopKeyPair.publicKey, //already a JWK
                privateKeyType: accessToken.dpopKeyPair.privateKey.type,
                // @ts-ignore
                privateKey: await jose.exportPKCS8(
                  // @ts-ignore
                  accessToken.dpopKeyPair.privateKey
                ),
              },
            }
      )
    );
    return {
      timestamp: new Date().toISOString(),
      cssTokensByUser: this.cssTokensByUser,
      authAccessTokenByUser: accessTokenForJson,
    };
  }
  async save(authCacheFile: string) {
    const cacheContent = await this.dump();
    cacheContent.filename = authCacheFile;
    await fs.writeFile(authCacheFile, JSON.stringify(cacheContent));
  }

  async load(authCacheFile: string) {
    const cacheContent = await fs.readFile(authCacheFile, "utf-8");
    await this.loadString(cacheContent);
  }

  async loadString(cacheContent: string) {
    const c = JSON.parse(cacheContent);
    if (
      !c.cssTokensByUser ||
      !c.authAccessTokenByUser ||
      !c.timestamp ||
      !Array.isArray(c.cssTokensByUser) ||
      !Array.isArray(c.authAccessTokenByUser)
    ) {
      throw new Error(
        `Invalid content loaded for AuthFetchCache: ${cacheContent}`
      );
    }
    this.cssTokensByUser = c.cssTokensByUser;
    this.authAccessTokenByUser = c.authAccessTokenByUser;
    this.loadedAuthCacheMeta = {
      timestamp: c.timestamp,
      filename: c.filename,
    };
    for (const accessToken of this.authAccessTokenByUser.values()) {
      if (accessToken) {
        //because we got if from JSON, accessToken.dpopKeyPair.privateKey will be PKCS8, not a KeyLike!
        accessToken.dpopKeyPair.privateKey = await jose.importPKCS8(
          // @ts-ignore
          accessToken.dpopKeyPair.privateKey,
          // @ts-ignore
          accessToken.dpopKeyPair.privateKeyType
        );

        //because we got if from JSON, accessToken.expire will be a string, not a Date!
        // @ts-ignore
        if (typeof accessToken.expire !== "number") {
          throw new Error(
            `AccessToken in JSON has expire of unexpected type` +
              ` (${typeof accessToken.expire} instead of number) value=${
                accessToken.expire
              }`
          );
        }
        const expireLong: number = <number>accessToken.expire;
        accessToken.expire = new Date(expireLong);
      }
    }
  }
}
