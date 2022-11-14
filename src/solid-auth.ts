import nodeFetch from "node-fetch";
import { Response, BodyInit } from "node-fetch";
import {
  buildAuthenticatedFetch,
  createDpopHeader,
  generateDpopKeyPair,
} from "@inrupt/solid-client-authn-core";
import { ResponseError } from "./error.js";
import { AnyFetchResponseType, AnyFetchType } from "./generic-fetch";

function accountEmail(account: string): string {
  return `${account}@example.org`;
}

export interface UserToken {
  id: string;
  secret: string;
}
export async function createUserToken(
  cssBaseUrl: string,
  account: string,
  password: string,
  fetcher: AnyFetchType = fetch
): Promise<UserToken> {
  //see https://github.com/CommunitySolidServer/CommunitySolidServer/blob/main/documentation/markdown/usage/client-credentials.md
  const res = await fetcher(`${cssBaseUrl}idp/credentials/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `token-css-populate-${account}`,
      email: accountEmail(account),
      password: password,
    }),
  });

  const body = await res.text();
  if (!res.ok) {
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

export async function getUserAuthFetch(
  cssBaseUrl: string,
  account: string,
  token: UserToken,
  fetcher: AnyFetchType = fetch
): Promise<AnyFetchType> {
  //see https://github.com/CommunitySolidServer/CommunitySolidServer/blob/main/documentation/markdown/usage/client-credentials.md
  const { id, secret } = token;

  const dpopKey = await generateDpopKeyPair();
  const authString = `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`;

  const url = `${cssBaseUrl}.oidc/token`; //ideally, fetch this from token_endpoint in .well-known/openid-configuration
  const res = await fetcher(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(authString).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      dpop: await createDpopHeader(url, "POST", dpopKey),
    },
    body: "grant_type=client_credentials&scope=webid",
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

  const { access_token: accessToken, expires_in: expiresIn } = JSON.parse(body);
  const authFetch: AnyFetchType = await buildAuthenticatedFetch(
    // @ts-ignore
    fetcher,
    accessToken,
    { dpopKey }
  );
  // console.log(`Created Access Token using CSS token:`);
  // console.log(`account=${account}`);
  // console.log(`id=${id}`);
  // console.log(`secret=${secret}`);
  // console.log(`expiresIn=${expiresIn}`);
  // console.log(`accessToken=${accessToken}`);
  return authFetch;
}
