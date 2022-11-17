#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import nodeFetch from "node-fetch";
import { Response as NodeJsResponse } from "node-fetch";
import { AuthFetchCache } from "./auth-fetch-cache.js";
import { once } from "events";
import {
  AnyFetchResponseType,
  AnyFetchType,
  es6fetch,
} from "./generic-fetch.js";
import { DurationCounter } from "./duration-counter.js";
import * as fs from "fs";

const argv = yargs(hideBin(process.argv))
  .option("url", {
    alias: "u",
    type: "string",
    description: "Base URL of the CSS",
    demandOption: true,
  })
  .option("duration", {
    alias: "fc",
    type: "number",
    description:
      "Total duration (in seconds) of the test. After this time, no new fetches are done. " +
      "If this option is used, --fetch-count is ignored." +
      "Default: run until all requested fetches are done.",
    demandOption: false,
  })
  .option("fetchCount", {
    alias: "fc",
    type: "number",
    description: "Number of fetches per user",
    demandOption: false,
    default: 10,
  })
  .option("parallel", {
    alias: "pc",
    type: "number",
    description: "Number of fetches in parallel",
    demandOption: false,
    default: 10,
  })
  .option("userCount", {
    alias: "uc",
    type: "number",
    description: "Number of users",
    demandOption: false,
    default: 10,
  })
  .option("filename", {
    alias: "f",
    type: "string",
    description: "File to download from pod",
    default: "dummy.txt",
  })
  .option("authenticate", {
    alias: "a",
    type: "boolean",
    description: "Authenticated as the user owning the file",
    default: false,
  })
  .option("authenticateCache", {
    type: "string",
    choices: ["none", "token", "all"],
    description:
      "For each user, cache all authentication, or only the CSS token, or authenticate fully each time.",
    default: "all",
  })
  .option("fetchVersion", {
    type: "string",
    choices: ["node", "es6"],
    description:
      "Use node-fetch or ES6 fetch (ES6 fetch is only available for nodejs versions >= 18)",
    default: "node",
  })
  .option("authCacheFile", {
    type: "string",
    description: "File to load/save the auth cache from/to",
  })
  .option("loadAuthCacheFile", {
    type: "boolean",
    description: "Load the auth cache from file before doing anything else?",
    default: false,
  })
  .option("saveAuthCacheFile", {
    type: "boolean",
    description:
      "Save the auth cache to file? (After pre-caching and after full run)",
    default: false,
  })
  .option("preCacheAuth", {
    type: "boolean",
    description: "Pre-cache the authentication before starting?",
    default: false,
  })
  .option("onlyPreCacheAuth", {
    type: "boolean",
    description: "Stop directly after pre-caching (and optionally saving)",
    default: false,
  })
  .help()
  .parseSync();

const cssBaseUrl = argv.url.endsWith("/") ? argv.url : argv.url + "/";
const podFilename = argv.filename;

interface StatusNumberInfo {
  [status: number]: number;
}

class Counter {
  total: number = 0;
  success: number = 0;
  failure: number = 0;
  exceptions: number = 0;
  statuses: StatusNumberInfo = {};

  success_duration_ms = new DurationCounter();
}

async function discardBodyData(response: NodeJsResponse | Response) {
  //handles both node-fetch repsonse body (NodeJS.ReadableStream) and ES6 fetch response body (ReadableStream)

  if (!response.body) {
    console.warn("No response body");
    return;
  }

  if (response.body.hasOwnProperty("getReader")) {
    //ES6 fetch

    // @ts-ignore
    const body: ReadableStream = response.body;

    const bodyReader = body.getReader();
    if (bodyReader) {
      let done = false;
      while (!done) {
        //discard data (value)
        const { done: d, value: _ } = await bodyReader.read();
        done = d;
      }
    }

    return;
  }
  if (response.body.hasOwnProperty("_eventsCount")) {
    //node-fetch

    // @ts-ignore
    const body: NodeJS.ReadableStream = response.body;

    body.on("readable", () => {
      let chunk;
      while (null !== (chunk = body.read())) {
        //discard data
      }
    });

    await once(body, "end");
    return;
  }
  const _ = await response.text();
  console.warn("Unknown fetch response body");
}

async function fetchPodFile(
  userIndex: number,
  podFileRelative: string,
  counter: Counter,
  authFetchCache: AuthFetchCache
) {
  const account = `user${userIndex}`;
  const aFetch = await authFetchCache.getAuthFetcher(userIndex);
  // console.log(`   Will fetch file from account ${account}, pod path "${podFileRelative}"`);
  counter.total++;
  try {
    const startedFetch = new Date().getTime();
    const res: AnyFetchResponseType = await aFetch(
      `${cssBaseUrl}${account}/${podFileRelative}`,
      {
        method: "GET",
        //open bug in nodejs typescript that AbortSignal.timeout doesn't work
        //  see https://github.com/node-fetch/node-fetch/issues/741
        // @ts-ignore
        signal: AbortSignal.timeout(4_000), // abort after 4 seconds //supported in nodejs>=17.3
      }
    );
    // console.log(`res.ok`, res.ok);
    // console.log(`res.status`, res.status);
    counter.statuses[res.status] = (counter.statuses[res.status] || 0) + 1;

    if (!res.ok) {
      const bodyError = await res.text();
      const errorMessage = `${res.status} - Fetching from account ${account}, pod path "${podFileRelative}" failed: ${bodyError}`;
      if (counter.failure - counter.exceptions < 10) {
        //only log first 10 status failures
        console.error(errorMessage);
      }
      //throw new Error(errorMessage);
      counter.failure++;
      return;
    } else {
      if (res.body) {
        await discardBodyData(res);
        const stoppedFetch = new Date().getTime(); //this method of timing is flawed for async!
        //Because you can't accurately time async calls. (But the inaccuracies are probably neglectable.)
        counter.success++;
        counter.success_duration_ms.addDuration(stoppedFetch - startedFetch);
      } else {
        console.warn("successful fetch, but no body!");
        counter.exceptions++;
      }
    }
  } catch (e) {
    if (counter.exceptions < 10) {
      //only log first 10 exceptions
      console.error(e);
    }
    counter.failure++;
  }
  // console.log(`res.text`, body);
}

async function awaitUntilEmpty(actionPromiseFactory: (() => Promise<void>)[]) {
  while (true) {
    const actionMaker = actionPromiseFactory.pop();
    if (!actionMaker) {
      break;
    }
    const action = actionMaker();
    await action;
  }
}

async function awaitUntilDeadline(
  actionMaker: () => Promise<void>,
  start: number,
  durationMillis: number
) {
  while (Date.now() - start < durationMillis) {
    const action = actionMaker();
    await action;
  }
}

async function main() {
  const userCount = argv.userCount || 1;
  const fetchCount = argv.fetchCount || 1;
  const parallel = argv.parallel || 10;
  const duration = argv.duration;
  // @ts-ignore
  const authenticateCache: "none" | "token" | "all" =
    argv.authenticateCache || "all";
  const authenticate = argv.authenticate || false;
  const useNodeFetch = argv.fetchVersion == "node" || false;
  const authCacheFile = argv.authCacheFile || null;
  const loadAuthCacheFile = argv.loadAuthCacheFile || false;
  const saveAuthCacheFile = argv.saveAuthCacheFile || false;
  const onlyPreCacheAuth = argv.onlyPreCacheAuth || false;
  const preCacheAuth = argv.preCacheAuth || argv.onlyPreCacheAuth || false; //onlyPreCacheAuth implies preCacheAuth

  const requests = [];
  const promises = [];

  const fetcher: AnyFetchType = useNodeFetch ? nodeFetch : es6fetch;

  const authFetchCache = new AuthFetchCache(
    cssBaseUrl,
    authenticate,
    authenticateCache,
    fetcher
  );

  if (loadAuthCacheFile && authCacheFile && fs.existsSync(authCacheFile)) {
    console.log(`Loading auth cache from '${authCacheFile}'`);
    await authFetchCache.load(authCacheFile);
    console.log(`Auth cache now has '${authFetchCache.toCountString()}'`);
  }

  if (authenticate && preCacheAuth) {
    const preCacheStart = new Date().getTime();
    await authFetchCache.preCache(userCount);
    const preCacheStop = new Date().getTime();
    console.log(
      `PreCache tool '${(preCacheStop - preCacheStart) / 1000.0} seconds'`
    );
    console.log(`Auth cache now has '${authFetchCache.toCountString()}'`);
  }

  console.log(`userCount=${userCount} authFetchCache=${authFetchCache}`);

  if (saveAuthCacheFile && authCacheFile) {
    console.log(`Saving auth cache to '${authCacheFile}'`);
    await authFetchCache.save(authCacheFile);
  }

  const printAuthCacheStats = function () {
    console.log(
      `Auth Duration Statistics:\n     token min=${
        authFetchCache.tokenFetchDuration.min
      } max=${
        authFetchCache.tokenFetchDuration.max
      } avg=${authFetchCache.tokenFetchDuration.avg()} (flawed method!)\n     access token min=${
        authFetchCache.authAccessTokenDuration.min
      } max=${
        authFetchCache.authAccessTokenDuration.max
      } avg=${authFetchCache.authAccessTokenDuration.avg()} (flawed method!)\n     authfetch min=${
        authFetchCache.authFetchDuration.min
      } max=${
        authFetchCache.authFetchDuration.max
      } avg=${authFetchCache.authFetchDuration.avg()} (flawed method!)`
    );
  };

  if (onlyPreCacheAuth) {
    printAuthCacheStats();
    console.log(`--onlyPreCacheAuth set: will exit now`);
    process.exit(0);
  }

  let counter = new Counter();
  const printFinal = function () {
    console.log(`authFetchCache=${authFetchCache}`);
    console.log(
      `Fetch Statistics: total=${counter.total} success=${
        counter.success
      } failure=${counter.failure} exceptions=${
        counter.exceptions
      } statuses=${JSON.stringify(counter.statuses)}`
    );
    //print stats, but warn that the method is flawed: you can't accurately time async calls. (But the inaccuracies are probably neglectable.)
    console.log(
      `Fetch Duration Statistics: min=${counter.success_duration_ms.min} max=${
        counter.success_duration_ms.max
      } avg=${counter.success_duration_ms.avg()} (flawed method!)`
    );
    printAuthCacheStats();
  };

  process.on("SIGINT", function () {
    console.log(`******* GOT SIGINT *****`);
    console.log(`* Downloads are still in progress...`);
    console.log(`* Dumping statistics and exiting:`);
    printFinal();
    process.exit(1);
  });

  if (duration) {
    const durationMillis = duration * 1000;
    const start = Date.now();

    //Execute as many fetches as needed to fill the requested time.
    let curUserId = 0;
    const requestMaker = () => {
      const userId = curUserId++;
      if (curUserId >= userCount) {
        curUserId = 0;
      }
      return fetchPodFile(userId, podFilename, counter, authFetchCache);
    };
    for (let p = 0; p < parallel; p++) {
      promises.push(
        Promise.race([
          awaitUntilDeadline(requestMaker, start, durationMillis),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("timeout")),
              durationMillis + 5_000
            )
          ),
        ])
      );
    }
    console.log(
      `Fetching files from ${userCount} users. Max ${parallel} parallel requests. Will stop after ${duration} seconds...`
    );
    await Promise.allSettled(promises);
    console.log(
      `All fetches completed after ${(Date.now() - start) / 1000.0} seconds.`
    );
  } else {
    //Execute all requested fetches, no matter how long it takes.
    for (let i = 0; i < fetchCount; i++) {
      for (let j = 0; j < userCount; j++) {
        requests.push(() =>
          fetchPodFile(j, podFilename, counter, authFetchCache)
        );
      }
    }
    for (let p = 0; p < parallel; p++) {
      promises.push(awaitUntilEmpty(requests));
    }
    console.log(
      `Fetching ${fetchCount} files from ${userCount} users. Max ${parallel} parallel requests...`
    );
    await Promise.allSettled(promises);
    console.log(`All fetches completed.`);
  }

  printFinal();
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
