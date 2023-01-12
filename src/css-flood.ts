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

let ya = yargs(hideBin(process.argv))
  .usage("Usage: $0 --url <url> [--steps <steps>] ...")
  //general options
  .option("url", {
    // alias: "u",
    type: "string",
    description: "Base URL of the CSS",
    demandOption: true,
  })
  .option("steps", {
    type: "string",
    description: `The steps that need to run, as a comma separated list. See below for more details.`,
    default: "flood",
  })
  //flood config
  .option("duration", {
    // alias: "fc",
    type: "number",
    description:
      "Total duration (in seconds) of the flood. After this time, no new fetches are done. " +
      "If this option is used, --fetch-count is ignored." +
      "Default: run until all requested fetches are done.",
    demandOption: false,
  })
  .option("fetchCount", {
    // alias: "fc",
    type: "number",
    description: "Number of fetches per user during the flood.",
    demandOption: false,
    default: 10,
  })
  .option("parallel", {
    // alias: "pc",
    type: "number",
    description: "Number of fetches in parallel during the flood.",
    demandOption: false,
    default: 10,
  })
  .option("userCount", {
    // alias: "uc",
    type: "number",
    description: "Number of users",
    demandOption: false,
    default: 10,
  })
  .option("fetchTimeoutMs", {
    // alias: "t",
    type: "number",
    description:
      "How long before aborting a fetch because it takes too long? (in ms)",
    demandOption: false,
    default: 4_000,
  })
  .option("filename", {
    // alias: "f",
    type: "string",
    description:
      "Remote file to download from pod, or filename of file to upload to pod",
    default: "dummy.txt",
  })
  .option("filenameIndexing", {
    type: "boolean",
    description:
      "Replace the literal string 'INDEX' in the filename for each action (upload/download). " +
      "This way, each fetch uses a unique filename. Index will start from 0 and increment.",
    default: false,
  })
  .option("uploadSizeByte", {
    type: "number",
    description: "Number of bytes of (random) data to upload for POST/PUT",
    default: 10,
  })
  .option("verb", {
    // alias: "v",
    type: "string",
    choices: ["GET", "PUT", "POST", "DELETE"],
    description: "HTTP verb to use for the flood: GET/PUT/POST/DELETE",
    default: "GET",
  })
  //authentication
  .option("authenticate", {
    // alias: "a",
    type: "boolean",
    description: "Authenticated as the user owning the target file",
    default: false,
  })
  .option("authenticateCache", {
    type: "string",
    choices: ["none", "token", "all"],
    description:
      "How much authentication should be cached? All authentication (=all)? Only the CSS user token (=token)? Or no caching (=none)?",
    default: "all",
  })
  .option("authCacheFile", {
    type: "string",
    description: "File to load/save the authentication cache from/to",
  })
  //advanced
  .option("fetchVersion", {
    type: "string",
    choices: ["node", "es6"],
    description:
      "Use node-fetch or ES6 fetch (ES6 fetch is only available for nodejs versions >= 18)",
    default: "node",
  })
  .epilogue(
    `Details for --steps:
    
css-flood performs one or more steps in a fixed order. 
--steps selects which steps run (and which don't).

A lot of these steps are related to the "Authentication Cache".
Note that this cache is not used if authentication is disabled.
How much the authentication cache caches, can also be configured with the --authenticateCache option.
The file used to load/save the authentication cache is controlled by the --authCacheFile option.

The steps that can run are (always in this order):

- loadAC: Load the authentication cache from file.
- fillAC: Perform authentication of all users, which fills the authentication cache.
- validateAC: Check if all entries in the authentication cache are up to date. 
              This step causes exit with code 1 if there is at least one cache entry that has expired.
- testRequests: Do 1 request (typically a GET to download a file) for each users (back-to-back, not in parallel). 
                This tests both the data in the authentication cache (adding missing entries), and the actual request.
- saveAC: Save the authentication cache to file.
- flood: Run the actual "flood": generate load on the target CSS by running a number of requests in parallel.

Examples:
--steps 'loadAC,validateAC,flood'
--steps 'fillAC,saveAC'
--steps 'loadAC,fillAC,saveAC'
--steps 'loadAC,testDownload,saveAC,flood'

All steps (makes little sense):
--steps 'loadAC,fillAC,validateAC,testDownload,saveAC,flood'

`
  )
  .coerce("steps", (arg) => {
    const res = arg.split(",");
    const allowedSteps = [
      "loadAC",
      "fillAC",
      "validateAC",
      "testDownload",
      "saveAC",
      "flood",
    ];
    for (const step of res) {
      if (!allowedSteps.includes(step)) {
        throw new Error(`${step} is not an known step`);
      }
    }
    return res;
  })
  .help()
  .wrap(120);

// ya = ya.wrap(ya.terminalWidth());
const argv = ya.parseSync();

enum HttpVerb {
  GET = "GET",
  PUT = "PUT",
  POST = "POST",
  DELETE = "DELETE",
}

const cssBaseUrl: string = argv.url.endsWith("/") ? argv.url : argv.url + "/";
const podFilename: string = argv.filename;
const filenameIndexing: boolean = argv.filenameIndexing;
const httpVerb: HttpVerb = <HttpVerb>argv.verb;
const mustUpload = httpVerb == "POST" || httpVerb == "PUT";
const uploadSizeByte: number = argv.uploadSizeByte;

let curIndex = 0;
function getUniqueIndex(): number {
  //no need at this point to use any fancy atomic operations. This is single threaded, so it is safe.
  return curIndex++;
}

function generateUploadData(
  httpVerb: HttpVerb,
  uploadSizeByte: number
): ArrayBuffer {
  const res = new Uint8Array(uploadSizeByte);
  const startTime = new Date().getTime();

  crypto.getRandomValues(res);
  // for (let i = 0; i < uploadSizeByte; i++) {
  //   res[i] = 0;
  // }

  const durationMs = new Date().getTime() - startTime;
  console.debug(
    `Generating random data for upload took ${durationMs}ms (for ${uploadSizeByte} bytes)`
  );
  return res;
}

const uploadData = mustUpload
  ? generateUploadData(httpVerb, uploadSizeByte)
  : null;

interface StatusNumberInfo {
  [status: number]: number;
}

class Counter {
  total: number = 0;
  success: number = 0;
  failure: number = 0;
  exceptions: number = 0;
  timeout: number = 0;
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
  authFetchCache: AuthFetchCache,
  fetchTimeoutMs: number,
  httpVerb: HttpVerb,
  filenameIndexing: boolean
) {
  try {
    const account = `user${userIndex}`;
    const aFetch = await authFetchCache.getAuthFetcher(userIndex);
    // console.log(`   Will fetch file from account ${account}, pod path "${podFileRelative}"`);
    counter.total++;
    const startedFetch = new Date().getTime();

    const options: any = {
      method: httpVerb,
      //open bug in nodejs typescript that AbortSignal.timeout doesn't work
      //  see https://github.com/node-fetch/node-fetch/issues/741
      // @ts-ignore
      signal: AbortSignal.timeout(fetchTimeoutMs), // abort after 4 seconds //supported in nodejs>=17.3
    };

    if (mustUpload) {
      options.headers = {
        "Content-type": "application/octet-stream",
      };
      options.body = uploadData;
    }

    if (filenameIndexing) {
      podFileRelative = podFileRelative.replace("INDEX", `${getUniqueIndex()}`);
    }

    const res: AnyFetchResponseType = await aFetch(
      `${cssBaseUrl}${account}/${podFileRelative}`,
      options
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
        if (httpVerb == "GET") {
          console.warn("successful fetch GET, but no body!");
          counter.failure++;
        } else {
          const stoppedFetch = new Date().getTime();
          counter.success++;
          counter.success_duration_ms.addDuration(stoppedFetch - startedFetch);
        }
      }
    }
  } catch (e: any) {
    counter.failure++;

    if (e.name === "AbortError") {
      counter.timeout++;
      console.error(`Fetch took longer than ${fetchTimeoutMs} ms: aborted`);
      return;
    }

    counter.exceptions++;
    if (counter.exceptions < 10) {
      //only log first 10 exceptions
      console.error(e);
    }
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
  try {
    while (Date.now() - start < durationMillis) {
      const action = actionMaker();
      await action;
    }
    // @ts-ignore
  } catch (err: any) {
    console.error(
      `Failed to fetch in awaitUntilDeadline loop (= implementation error): \n${err.name}: ${err.message}`
    );
    console.error(err);
    process.exit(2);
  }
}

async function main() {
  const userCount = argv.userCount || 1;
  const fetchTimeoutMs = argv.fetchTimeoutMs || 4_000;
  const fetchCount = argv.fetchCount || 1;
  const parallel = argv.parallel || 10;
  const duration = argv.duration;
  // @ts-ignore
  const authenticateCache: "none" | "token" | "all" =
    argv.authenticateCache || "all";
  const authenticate = argv.authenticate || false;
  const useNodeFetch = argv.fetchVersion == "node" || false;
  const authCacheFile = argv.authCacheFile || null;

  const steps: string[] = argv.steps;

  const requests = [];
  const promises = [];

  const fetcher: AnyFetchType = useNodeFetch ? nodeFetch : es6fetch;

  const authFetchCache = new AuthFetchCache(
    cssBaseUrl,
    authenticate,
    authenticateCache,
    fetcher
  );

  if (
    steps.includes("loadAC") &&
    authCacheFile &&
    fs.existsSync(authCacheFile)
  ) {
    console.log(`Loading auth cache from '${authCacheFile}'`);
    await authFetchCache.load(authCacheFile);
    console.log(`Auth cache now has '${authFetchCache.toCountString()}'`);
  }

  if (authenticate && steps.includes("fillAC")) {
    const preCacheStart = new Date().getTime();
    await authFetchCache.preCache(userCount);
    const preCacheStop = new Date().getTime();
    console.log(
      `PreCache took '${(preCacheStop - preCacheStart) / 1000.0} seconds'`
    );
    console.log(`Auth cache now has '${authFetchCache.toCountString()}'`);
  }

  if (authenticate && steps.includes("validateAC")) {
    authFetchCache.validate(userCount);
  }
  if (authenticate && steps.includes("testRequests")) {
    await authFetchCache.test(
      userCount,
      cssBaseUrl,
      podFilename,
      fetchTimeoutMs
    );
  }

  console.log(`userCount=${userCount} authFetchCache=${authFetchCache}`);

  if (steps.includes("saveAC") && authCacheFile) {
    console.log(`Saving auth cache to '${authCacheFile}'`);
    await authFetchCache.save(authCacheFile);
  }

  const authCacheStatsToObj = function () {
    return {
      warning:
        "Flawed method! " +
        "You can't accurately time async calls. " +
        "But the inaccuracies are probably neglectable.",
      getchingUserTokenDuration: {
        min: authFetchCache.tokenFetchDuration.min,
        max: authFetchCache.tokenFetchDuration.max,
        avg: authFetchCache.tokenFetchDuration.avg(),
      },
      authAccessTokenDuration: {
        min: authFetchCache.authAccessTokenDuration.min,
        max: authFetchCache.authAccessTokenDuration.max,
        avg: authFetchCache.authAccessTokenDuration.avg(),
      },
      buildingAuthFetcherDuration: {
        min: authFetchCache.authFetchDuration.min,
        max: authFetchCache.authFetchDuration.max,
        avg: authFetchCache.authFetchDuration.avg(),
      },
      generateDpopKeyPairDuration: {
        min: authFetchCache.generateDpopKeyPairDurationCounter.min,
        max: authFetchCache.generateDpopKeyPairDurationCounter.max,
        avg: authFetchCache.generateDpopKeyPairDurationCounter.avg(),
      },
    };
  };

  if (!steps.includes("flood")) {
    console.log(
      "AUTHENTICATION CACHE STATISTICS:\n---\n" +
        JSON.stringify({
          authFetchCache: {
            stats: authFetchCache.toStatsObj(),
            durations: authCacheStatsToObj(),
          },
        }) +
        "\n---\n\n"
    );
    console.log(`--steps does not include flood: will exit now`);
    process.exit(0);
  }

  let counter = new Counter();
  const printFinal = function () {
    const stats = {
      authFetchCache: {
        stats: authFetchCache.toStatsObj(),
        durations: authCacheStatsToObj(),
      },
      fetchStatistics: {
        total: counter.total,
        success: counter.success,
        failure: counter.failure,
        exceptions: counter.exceptions,
        statuses: counter.statuses,
        timeout: counter.timeout,
      },
      durationStatistics: {
        warning:
          "Flawed method! " +
          "You can't accurately time async calls. " +
          "But the inaccuracies are probably neglectable.",
        min: counter.success_duration_ms.min,
        max: counter.success_duration_ms.max,
        avg: counter.success_duration_ms.avg(),
      },
    };
    console.log(
      "FINAL STATISTICS:\n---\n" + JSON.stringify(stats) + "\n---\n\n"
    );
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
      return fetchPodFile(
        userId,
        podFilename,
        counter,
        authFetchCache,
        fetchTimeoutMs,
        httpVerb,
        filenameIndexing
      );
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
    const runMillis = Date.now() - start;
    console.log(`All fetches completed after ${runMillis / 1000.0} seconds.`);
    if (runMillis < durationMillis) {
      console.error(
        `ERROR: Fetches completed too early!\n    runtime=${runMillis} ms\n    requested duration=${duration} s (=${durationMillis} ms)\n`
      );
      process.exit(1);
    }
  } else {
    //Execute all requested fetches, no matter how long it takes.
    for (let i = 0; i < fetchCount; i++) {
      for (let j = 0; j < userCount; j++) {
        requests.push(() =>
          fetchPodFile(
            j,
            podFilename,
            counter,
            authFetchCache,
            fetchTimeoutMs,
            httpVerb,
            filenameIndexing
          )
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
