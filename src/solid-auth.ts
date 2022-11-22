import {
  buildAuthenticatedFetch,
  createDpopHeader,
  generateDpopKeyPair,
} from "@inrupt/solid-client-authn-core";
import { ResponseError } from "./error.js";
import { AnyFetchResponseType, AnyFetchType } from "./generic-fetch.js";
import { DurationCounter } from "./duration-counter.js";

function accountEmail(account: string): string {
  return `${account}@example.org`;
}

export interface UserToken {
  id: string;
  secret: string;
}
export interface AccessToken {
  token: string;
  expire: Date;
}
export async function createUserToken(
  cssBaseUrl: string,
  account: string,
  password: string,
  fetcher: AnyFetchType = fetch,
  durationCounter: DurationCounter | null = null
): Promise<UserToken> {
  //see https://github.com/CommunitySolidServer/CommunitySolidServer/blob/main/documentation/markdown/usage/client-credentials.md
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  const startTime = new Date().getTime();
  let res = null;
  let body = null;
  try {
    res = await fetcher(`${cssBaseUrl}idp/credentials/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `token-css-populate-${account}`,
        email: accountEmail(account),
        password: password,
      }),
      signal: controller.signal,
    });

    body = await res.text();
  } catch (error: any) {
    if (error.name === "AbortError") {
      console.error(`Fetching user token took too long: aborted`);
    }
    throw error;
  } finally {
    if (durationCounter !== null) {
      durationCounter.addDuration(new Date().getTime() - startTime);
    }
  }
  if (!res || !res.ok) {
    // if (body.includes(`Could not create token for ${account}`)) {
    //     //ignore
    //     return {};
    // }
    console.error(`${res.status} - Creating token for ${account} failed:`);
    console.error(body);
    throw new ResponseError(res, body);
  }

  const { id, secret } = JSON.parse(body);
  return { id, secret };
}

export function stillUsableAccessToken(accessToken: AccessToken): boolean {
  if (!accessToken.token || !accessToken.expire) {
    return false;
  }
  const now = new Date().getTime();
  const expire = accessToken.expire.getTime();
  const deadline_s = 5 * 60;
  //accessToken.expire should be 5 minutes in the future at least
  return expire > now && expire - now > deadline_s;
}

export async function getUserAuthFetch(
  cssBaseUrl: string,
  account: string,
  token: UserToken,
  fetcher: AnyFetchType = fetch,
  accessTokenDurationCounter: DurationCounter | null = null,
  fetchDurationCounter: DurationCounter | null = null,
  accessToken: AccessToken | null = null
): Promise<[AnyFetchType, AccessToken]> {
  //see https://github.com/CommunitySolidServer/CommunitySolidServer/blob/main/documentation/markdown/usage/client-credentials.md
  const { id, secret } = token;

  const dpopKey = await generateDpopKeyPair();
  const authString = `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  const url = `${cssBaseUrl}.oidc/token`; //ideally, fetch this from token_endpoint in .well-known/openid-configuration

  const accessTokenDurationStart = new Date().getTime();
  try {
    if (accessToken === null || !stillUsableAccessToken(accessToken)) {
      const res = await fetcher(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(authString).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          dpop: await createDpopHeader(url, "POST", dpopKey),
        },
        body: "grant_type=client_credentials&scope=webid",
        signal: controller.signal,
      });

      const body = await res.text();
      if (!res.ok) {
        // if (body.includes(`Could not create access token for ${account}`)) {
        //     //ignore
        //     return {};
        // }
        console.error(
          `${res.status} - Creating access token for ${account} failed:`
        );
        console.error(body);
        throw new ResponseError(res, body);
      }

      const { access_token: accessTokenStr, expires_in: expiresIn } =
        JSON.parse(body);
      const expire = new Date(
        new Date().getTime() + parseInt(expiresIn) * 1000
      );
      accessToken = { token: accessTokenStr, expire: expire };
    }
  } catch (error: any) {
    if (error.name === "AbortError") {
      console.error(`Fetching access token took too long: aborted`);
    }
    throw error;
  } finally {
    if (accessTokenDurationCounter !== null) {
      accessTokenDurationCounter.addDuration(
        new Date().getTime() - accessTokenDurationStart
      );
    }
  }

  const fetchDurationStart = new Date().getTime();
  try {
    const authFetch: AnyFetchType = await buildAuthenticatedFetch(
      // @ts-ignore
      fetcher,
      accessToken.token,
      { dpopKey }
    );
    // console.log(`Created Access Token using CSS token:`);
    // console.log(`account=${account}`);
    // console.log(`id=${id}`);
    // console.log(`secret=${secret}`);
    // console.log(`expiresIn=${expiresIn}`);
    // console.log(`accessToken=${accessTokenStr}`);

    return [authFetch, accessToken];
  } finally {
    if (fetchDurationCounter !== null) {
      fetchDurationCounter.addDuration(
        new Date().getTime() - fetchDurationStart
      );
    }
  }
}
