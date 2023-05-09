#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import nodeFetch from "node-fetch";
import { Response as NodeJsResponse } from "node-fetch";
import {
  AuthFetchCache,
  AuthFetchCacheStats,
  fromNow,
} from "./auth-fetch-cache.js";
import { once } from "events";
import {
  AnyFetchResponseType,
  AnyFetchType,
  es6fetch,
} from "./generic-fetch.js";
import { DurationCounter } from "./duration-counter.js";
import * as fs from "fs";
import { promises as afs } from "fs";
import { AccessToken } from "./solid-auth.js";
import { webcrypto } from "node:crypto";
import {
  CliArgs,
  FetchScenario,
  HttpVerb,
  StepName,
} from "./css-flood-args.js";
import { pid } from "node:process";
import { RDFContentTypeMap, RDFExtMap, RDFTypeValues } from "./rdf-helpers.js";
import N3, { BlankNode, DataFactory, NamedNode, Quad } from "n3";
import { Writable } from "stream";
import { pipeline } from "node:stream/promises";
import namedNode = DataFactory.namedNode;
import blankNode = DataFactory.blankNode;
import quad = DataFactory.quad;
import variable = DataFactory.variable;
import literal = DataFactory.literal;
import * as RDF from "rdf-js";

export function generateUploadData(
  httpVerb: HttpVerb,
  uploadSizeByte: number
): ArrayBuffer {
  const res = new Uint8Array(uploadSizeByte);
  const startTime = new Date().getTime();

  webcrypto.getRandomValues(res);
  // for (let i = 0; i < uploadSizeByte; i++) {
  //   res[i] = 0;
  // }

  const durationMs = new Date().getTime() - startTime;
  console.debug(
    `Generating random data for upload took ${durationMs}ms (for ${uploadSizeByte} bytes)`
  );
  return res;
}

export interface StatusNumberInfo {
  [status: number]: number;
}

export class Counter {
  total: number = 0;
  success: number = 0;
  failure: number = 0;
  exceptions: number = 0;
  timeout: number = 0;
  statuses: StatusNumberInfo = {};

  success_duration_ms = new DurationCounter();
}

export async function discardBodyData(response: NodeJsResponse | Response) {
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
    if (!body.readable) {
      return;
    }

    body.on("readable", () => {
      let chunk;
      while (null !== (chunk = body.read())) {
        //discard data
      }
    });

    //TODO race condition possible?!

    await once(body, "end");
    return;
  }
  const _ = await response.text();
  console.warn("Unknown fetch response body");
}

export async function fetchPodFile(
  scenario: FetchScenario,
  userIndex: number,
  podFileRelative: string,
  counter: Counter,
  authFetchCache: AuthFetchCache,
  fetchTimeoutMs: number,
  httpVerb: HttpVerb,
  filenameIndexing: boolean,
  fetchIndex: number,
  cssBaseUrl: string,
  mustUpload: boolean,
  uploadData?: Promise<ArrayBuffer>
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

    switch (scenario) {
      case "BASIC": {
        if (mustUpload) {
          options.headers = {
            "Content-type": "application/octet-stream",
          };
          options.body = await uploadData;
        }

        if (filenameIndexing) {
          podFileRelative = podFileRelative.replace("INDEX", `${fetchIndex}`);
        }
        break;
      }
      case "N3_PATCH": {
        console.assert(mustUpload);
        console.assert(httpVerb == "PATCH");

        // N3 PATCH requires "text/n3" content type header (see https://solidproject.org/TR/protocol#writing-resources)
        options.headers = {
          "Content-type": "text/n3",
        };
        options.body = await uploadData;

        podFileRelative = `rdf_example_N_TRIPLES.nt`;
        break;
      }
      case "NO_CONTENT_TRANSLATION": {
        //No content translation: we fetch the requested files in their own content-type (= no Accept header)
        console.assert(httpVerb == "GET");

        const typeIndex = fetchIndex % (RDFTypeValues.length - 2);
        const filenameType = RDFTypeValues[typeIndex];
        const contentTypeType = RDFTypeValues[typeIndex];

        podFileRelative = `rdf_example_${filenameType}.${RDFExtMap[filenameType]}`;
        //No content translation, so just don't specify Accept header.
        // options.headers = {
        //   "Accept": RDFContentTypeMap[contentTypeType],
        // };
        if (userIndex < 2 && fetchIndex < 25) {
          console.log(
            `DEBUG ${scenario}: download u${userIndex}-f${fetchIndex} "${podFileRelative}" without Accept header"`
          );
        }
        break;
      }
      case "CONTENT_TRANSLATION": {
        console.assert(httpVerb == "GET");

        //for convenience "RDF_XML" is the last of RDFTypeValues

        // //**version that includes RDF_XML in Accept but not in filename**:
        // //We use fetchIndex to select a combination of filename and Accept
        // // There are (RDFTypeValues.length-1) files that can be requested  (since we exclude RDF_XML)
        // // There are (RDFTypeValues.length-1) types to request each file in (because we don't request them in their own type but include RDF_XML.)
        // // That's (RDFTypeValues.length-1)*(RDFTypeValues.length-1) combinations
        // const combinationId =
        //   fetchIndex %
        //   ((RDFTypeValues.length - 1) * (RDFTypeValues.length - 1));
        // const fileNameIndex = combinationId % (RDFTypeValues.length - 1);
        // const contentTypeIndex = Math.floor(
        //   (combinationId - fileNameIndex) / (RDFTypeValues.length - 1)
        // );
        // const filenameType = RDFTypeValues[fileNameIndex];
        // const contentTypeType =
        //   contentTypeIndex == RDFTypeValues.indexOf(filenameType)
        //     ? RDFTypeValues[contentTypeIndex + 1]
        //     : RDFTypeValues[contentTypeIndex];

        //**version that does not include RDF_XML at all**:
        //We use fetchIndex to select a combination of filename and Accept
        // There are (RDFTypeValues.length-1) files that can be requested  (since we exclude RDF_XML)
        // There are (RDFTypeValues.length-2) types to request each file in (because we don't request them in their own type and exlude RDF_XML.)
        // That's (RDFTypeValues.length-1)*(RDFTypeValues.length-2) combinations
        const combinationId =
          fetchIndex %
          ((RDFTypeValues.length - 1) * (RDFTypeValues.length - 2));
        const fileNameIndex = combinationId % (RDFTypeValues.length - 1);
        let contentTypeIndex = Math.floor(
          (combinationId - fileNameIndex) / (RDFTypeValues.length - 1)
        );
        const filenameType = RDFTypeValues[fileNameIndex];
        const contentTypeType =
          contentTypeIndex == RDFTypeValues.indexOf(filenameType)
            ? RDFTypeValues[RDFTypeValues.length - 2]
            : RDFTypeValues[contentTypeIndex];

        podFileRelative = `rdf_example_${filenameType}.${RDFExtMap[filenameType]}`;
        options.headers = {
          Accept: RDFContentTypeMap[contentTypeType],
        };
        if (userIndex < 2 && fetchIndex < 25) {
          console.log(
            `DEBUG ${scenario}: download u${userIndex}-f${fetchIndex} "${podFileRelative}" as "${options.headers["Accept"]}"`
          );
        }
        break;
      }
    }

    const url = `${cssBaseUrl}${account}/${podFileRelative}`;
    const res: AnyFetchResponseType = await aFetch(url, options);
    counter.statuses[res.status] = (counter.statuses[res.status] || 0) + 1;

    //For the N3 PATCH scenario, we consider 409 success as well.
    if (!res.ok && (scenario != "N3_PATCH" || res.status != 409)) {
      const bodyError = await res.text();
      const errorMessage =
        `${res.status} - ${httpVerb} with account ${account}, pod path "${podFileRelative}" failed` +
        `(URL=${url}): ${bodyError}`;
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
        //Because you can't accurately time async calls. (But the inaccuracies are probably negligible.)
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

export async function awaitUntilEmpty(
  actionPromiseFactory: (() => Promise<void>)[]
) {
  while (true) {
    const actionMaker = actionPromiseFactory.pop();
    if (!actionMaker) {
      break;
    }
    const action = actionMaker();
    await action;
  }
}

export async function awaitUntilDeadline(
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

export interface MinMaxAvgSumCount {
  min: number;
  max: number;
  avg: number;
  sum: number;
  count: number;
}

export interface AuthFetchCacheDurationStats {
  warning: string;
  fetchUserToken: MinMaxAvgSumCount;
  authAccessToken: MinMaxAvgSumCount;
  buildingAuthFetcher: MinMaxAvgSumCount;
  generateDpopKeyPair: MinMaxAvgSumCount;
}

export function authCacheStatsToObj(
  authFetchCache: AuthFetchCache
): AuthFetchCacheDurationStats {
  return {
    warning:
      "Flawed method! " +
      "You can't accurately time async calls. " +
      "But the inaccuracies are probably negligible.",
    fetchUserToken: {
      min: authFetchCache.tokenFetchDuration.min,
      max: authFetchCache.tokenFetchDuration.max,
      avg: authFetchCache.tokenFetchDuration.avg(),
      sum: authFetchCache.tokenFetchDuration.sum,
      count: authFetchCache.tokenFetchDuration.count,
    },
    authAccessToken: {
      min: authFetchCache.authAccessTokenDuration.min,
      max: authFetchCache.authAccessTokenDuration.max,
      avg: authFetchCache.authAccessTokenDuration.avg(),
      sum: authFetchCache.authAccessTokenDuration.sum,
      count: authFetchCache.authAccessTokenDuration.count,
    },
    buildingAuthFetcher: {
      min: authFetchCache.authFetchDuration.min,
      max: authFetchCache.authFetchDuration.max,
      avg: authFetchCache.authFetchDuration.avg(),
      sum: authFetchCache.authFetchDuration.sum,
      count: authFetchCache.authFetchDuration.count,
    },
    generateDpopKeyPair: {
      min: authFetchCache.generateDpopKeyPairDurationCounter.min,
      max: authFetchCache.generateDpopKeyPairDurationCounter.max,
      avg: authFetchCache.generateDpopKeyPairDurationCounter.avg(),
      sum: authFetchCache.generateDpopKeyPairDurationCounter.sum,
      count: authFetchCache.generateDpopKeyPairDurationCounter.count,
    },
  };
}

export async function reportAuthCacheStatistics(
  authFetchCache: AuthFetchCache,
  reportFile?: string
) {
  const reportObj = {
    authFetchCache: {
      stats: authFetchCache.toStatsObj(),
      durations: authCacheStatsToObj(authFetchCache),
    },
  };
  const reportContent = JSON.stringify(reportObj);
  if (!reportFile) {
    console.log(
      "AUTHENTICATION CACHE STATISTICS:\n---\n" + reportContent + "\n---\n\n"
    );
  } else {
    console.log(`Writing report to '${reportFile}'...`);
    await afs.writeFile(reportFile, reportContent);
    console.log(`Report saved`);
  }
  console.log(`--steps does not include flood: will exit now`);
  process.exit(0);
}

export interface FloodStatistics {
  pid: number[];
  authFetchCache: {
    stats: AuthFetchCacheStats;
    durations: AuthFetchCacheDurationStats;
  };
  fetchStatistics: {
    total: number;
    success: number;
    failure: number;
    exceptions: number;
    statuses: StatusNumberInfo;
    timeout: number;
    durationMs: MinMaxAvgSumCount; //MinMaxAvgSumCount over all separate processes.
  };
  durationStatistics: {
    warning: string;
    min: number;
    max: number;
    avg: number;
    sum: number;
    count: number;
  };
}

export function makeStatistics(
  counter: Counter,
  allFetchStartEnd: { start: number | null; end: number | null },
  authFetchCache: AuthFetchCache
): FloodStatistics {
  const singleMinMaxAvg = (v: number) => {
    return {
      min: v,
      max: v,
      avg: v,
      sum: v,
      count: 1,
    };
  };

  return {
    pid: [pid],
    authFetchCache: {
      stats: authFetchCache.toStatsObj(),
      durations: authCacheStatsToObj(authFetchCache),
    },
    fetchStatistics: {
      total: counter.total,
      success: counter.success,
      failure: counter.failure,
      exceptions: counter.exceptions,
      statuses: counter.statuses,
      timeout: counter.timeout,
      durationMs: singleMinMaxAvg(
        allFetchStartEnd.start != null && allFetchStartEnd.end != null
          ? allFetchStartEnd.end - allFetchStartEnd.start
          : -1
      ),
    },
    durationStatistics: {
      warning:
        "Flawed method! " +
        "You can't accurately time async calls. " +
        "But the inaccuracies are probably negligible.",
      min: counter.success_duration_ms.min,
      max: counter.success_duration_ms.max,
      avg: counter.success_duration_ms.avg(),
      sum: counter.success_duration_ms.sum,
      count: counter.success_duration_ms.count,
    },
  };
}

export function sumStatistics(floodStats: FloodStatistics[]): FloodStatistics {
  const sum = (getter: (value: FloodStatistics) => number) => {
    return floodStats
      .map(getter)
      .reduce(
        (accumulator: number, currentValue: number) =>
          accumulator + currentValue,
        0
      );
  };
  const mergeAvgMinMax = (
    getter: (value: FloodStatistics) => MinMaxAvgSumCount
  ) => {
    return floodStats.map(getter).reduce(
      (accumulator: MinMaxAvgSumCount, currentValue: MinMaxAvgSumCount) => {
        return accumulator.count == 0
          ? {
              min: currentValue.min,
              max: currentValue.max,
              avg: currentValue.avg,
              sum: currentValue.sum,
              count: currentValue.count,
            }
          : {
              min: Math.min(accumulator.min, currentValue.min),
              max: Math.max(accumulator.max, currentValue.max),
              avg:
                (accumulator.sum + currentValue.sum) /
                (accumulator.count + currentValue.count),
              sum: accumulator.sum + currentValue.sum,
              count: accumulator.count + currentValue.count,
            };
      },
      {
        min: 0,
        max: 0,
        avg: 0,
        sum: 0,
        count: 0,
      }
    );
  };
  const mergeStatusNumberInfo = (
    getter: (value: FloodStatistics) => StatusNumberInfo
  ) => {
    return floodStats
      .map(getter)
      .reduce(
        (accumulator: StatusNumberInfo, currentValue: StatusNumberInfo) => {
          const res = { ...accumulator };
          for (const [k, v] of Object.entries(currentValue)) {
            if (res.hasOwnProperty(k)) {
              // @ts-ignore
              res[k] += v;
            } else {
              // @ts-ignore
              res[k] = v;
            }
          }
          return res;
        },
        {}
      );
  };
  console.assert(floodStats.length > 0);
  const first = floodStats[0];
  return {
    pid: floodStats.map((fs) => fs.pid).flat(),
    authFetchCache: {
      stats: {
        cssBaseUrl: first.authFetchCache.stats.cssBaseUrl,
        authenticateCache: first.authFetchCache.stats.authenticateCache,
        authenticate: first.authFetchCache.stats.authenticate,
        lenCssTokensByUser: sum(
          (fs) => fs.authFetchCache.stats.lenCssTokensByUser
        ),
        lenAuthAccessTokenByUser: sum(
          (fs) => fs.authFetchCache.stats.lenAuthAccessTokenByUser
        ),
        lenAuthFetchersByUser: sum(
          (fs) => fs.authFetchCache.stats.lenAuthFetchersByUser
        ),
        useCount: sum((fs) => fs.authFetchCache.stats.useCount),
        tokenFetchCount: sum((fs) => fs.authFetchCache.stats.tokenFetchCount),
        authFetchCount: sum((fs) => fs.authFetchCache.stats.authFetchCount),
      },
      durations: {
        warning: first.authFetchCache.durations.warning,
        fetchUserToken: mergeAvgMinMax(
          (fs) => fs.authFetchCache.durations.fetchUserToken
        ),
        authAccessToken: mergeAvgMinMax(
          (fs) => fs.authFetchCache.durations.authAccessToken
        ),
        buildingAuthFetcher: mergeAvgMinMax(
          (fs) => fs.authFetchCache.durations.buildingAuthFetcher
        ),
        generateDpopKeyPair: mergeAvgMinMax(
          (fs) => fs.authFetchCache.durations.generateDpopKeyPair
        ),
      },
    },
    fetchStatistics: {
      total: sum((fs) => fs.fetchStatistics.total),
      success: sum((fs) => fs.fetchStatistics.success),
      failure: sum((fs) => fs.fetchStatistics.failure),
      exceptions: sum((fs) => fs.fetchStatistics.exceptions),
      statuses: mergeStatusNumberInfo((fs) => fs.fetchStatistics.statuses),
      timeout: sum((fs) => fs.fetchStatistics.timeout),
      durationMs: mergeAvgMinMax((fs) => fs.fetchStatistics.durationMs),
    },
    durationStatistics: {
      warning: first.durationStatistics.warning,
      ...mergeAvgMinMax((fs) => fs.durationStatistics),
    },
  };
}

export async function reportFinalStatistics(
  counter: Counter,
  allFetchStartEnd: { start: number | null; end: number | null },
  authFetchCache: AuthFetchCache,
  reportFile?: string
) {
  const reportObj = makeStatistics(counter, allFetchStartEnd, authFetchCache);
  const reportContent = JSON.stringify(reportObj);
  if (!reportFile) {
    console.log("FINAL STATISTICS:\n---\n" + reportContent + "\n---\n\n");
  } else {
    console.log(`Writing report to '${reportFile}'...`);
    await afs.writeFile(reportFile, reportContent);
    console.log(`Report saved`);
  }
}

export async function stepLoadAuthCache(
  authFetchCache: AuthFetchCache,
  authCacheFile: string,
  userCount: number
) {
  console.log(`Loading auth cache from '${authCacheFile}'`);
  await authFetchCache.load(authCacheFile);
  console.log(`Auth cache now has '${authFetchCache.toCountString()}'`);

  //print info about loaded Access Tokens
  let earliestATexpiration: Date | null = null;
  let earliestATUserIndex: number | null = null;
  for (let userIndex = 0; userIndex < userCount; userIndex++) {
    const accessToken = authFetchCache.authAccessTokenByUser[userIndex];
    if (
      accessToken != null &&
      (earliestATexpiration == null ||
        accessToken.expire.getTime() < earliestATexpiration.getTime())
    ) {
      earliestATexpiration = accessToken.expire;
      earliestATUserIndex = userIndex;
    }
  }
  console.log(
    `     First AccessToken expiration: ${earliestATexpiration?.toISOString()}=${fromNow(
      earliestATexpiration
    )}` + ` (user ${earliestATUserIndex})`
  );
  console.log(
    `     Loaded AuthCache metadata: ${JSON.stringify(
      authFetchCache.loadedAuthCacheMeta,
      null,
      3
    )}`
  );
}

interface N3PatchGeneratorTargetQuad {
  changePredicate: N3.Quad_Predicate;
  // changePredicate: NamedNode;
  changeOldValue: N3.Quad_Object;
  matchPredicate: N3.Quad_Predicate;
  matchObject: N3.Quad_Object;
}

interface N3PatchGeneratorState {
  next: number;
  targets: N3PatchGeneratorTargetQuad[];
}

async function prepareN3PatchGenerator(
  n3PatchGenFilename: string,
  processIndex: number,
  processCount: number,
  maxAsyncRequests: number
): Promise<N3PatchGeneratorState> {
  const subjects: Set<N3.Quad_Subject> = new Set();

  const predObjCounts: Map<string, number> = new Map();

  // const namePred = namedNode("http://nl.dbpedia.org/property/naam");
  // console.log("Looking for ", namePred);

  const predObjKeyMaker = (v: [N3.Quad_Predicate, N3.Quad_Object]) =>
    JSON.stringify(v);

  {
    const inputStream = fs.createReadStream(n3PatchGenFilename);
    const parserStream = new N3.StreamParser();
    inputStream.pipe(parserStream);
    const processor = new Writable({ objectMode: true });
    processor._write = (quad: Quad, encoding, done) => {
      subjects.add(quad.subject);
      const c = predObjCounts.get(
        predObjKeyMaker([quad.predicate, quad.object])
      );
      predObjCounts.set(
        predObjKeyMaker([quad.predicate, quad.object]),
        typeof c === "number" ? c + 1 : 1
      );
      done();
    };
    // parserStream.on("end", () => {
    //   console.log(`Parse end`);
    // });
    parserStream.on("error", (error) => {
      console.log(`Parse problem`, error);
    });
    // parserStream.pipe(processor);
    await pipeline(parserStream, processor);
  }

  // console.log(`Got ${subjectsWithName.size} subjects with a name`);
  if (subjects.size === 0) {
    throw new Error(`No expected RDF data read from ${n3PatchGenFilename}`);
  }
  if ([...predObjCounts.values()].filter((v) => v > 1).length === 0) {
    throw new Error(
      `There are no unique props/objs for any subject. That can't be right.`
    );
  }

  interface TargetInfo {
    match: [N3.Quad_Predicate, N3.Quad_Object] | undefined;
    others: [N3.Quad_Predicate, N3.Quad_Object][];
  }
  const targetInfoBySubject: Map<string, TargetInfo> = new Map();

  const subjKeyMaker = (v: N3.Quad_Subject) => JSON.stringify(v);

  {
    const inputStream = fs.createReadStream(n3PatchGenFilename);
    const parserStream = new N3.StreamParser();
    inputStream.pipe(parserStream);
    const processor = new Writable({ objectMode: true });
    processor._write = (quad: Quad, encoding, done) => {
      const targetInfo: TargetInfo = targetInfoBySubject.get(
        subjKeyMaker(quad.subject)
      ) || {
        match: undefined,
        others: [],
      };
      if (targetInfo.match === undefined && targetInfo.others.length === 0) {
        targetInfoBySubject.set(subjKeyMaker(quad.subject), targetInfo);
      }
      if (
        predObjCounts.get(predObjKeyMaker([quad.predicate, quad.object])) ===
          1 &&
        targetInfo.match === undefined
      ) {
        targetInfo.match = [quad.predicate, quad.object];
      } else {
        targetInfo.others.push([quad.predicate, quad.object]);
      }
      done();
    };
    // parserStream.on("end", () => {
    //   console.log(`Parse end`);
    // });
    parserStream.on("error", (error) => {
      console.log(`Parse problem`, error);
    });
    await pipeline(parserStream, processor);
  }

  if (targetInfoBySubject.size === 0) {
    throw new Error(`targetInfoBySubject.size === 0`);
  }

  const targets: N3PatchGeneratorTargetQuad[] = [];
  for (const [subjectValue, target_info] of targetInfoBySubject.entries()) {
    if (target_info.match !== undefined && target_info.others.length > 0) {
      for (const other of target_info.others) {
        targets.push({
          changePredicate: other[0],
          changeOldValue: other[1],
          matchPredicate: target_info.match[0],
          matchObject: target_info.match[1],
        });
      }
    } else {
      console.log(`No targets for subject ${subjectValue}!`, target_info);
    }
  }

  //Take a subset of targets for this process, taking processIndex and processCount into account.
  const pRemainder = targets.length % processCount;
  const pQuotient = (targets.length - pRemainder) / processCount;
  //we ignore the remainder to make things easy. There should be enough anyway. And if not the remainder can't make the difference anyway.
  const myTargetStartIndexIncl = pQuotient * processIndex;
  const myTargetEndIndexExcl = pQuotient * (processIndex + 1);
  const myTargets = targets.slice(myTargetStartIndexIncl, myTargetEndIndexExcl);

  //Check if there are enough in this subset to satisfy maxAsyncRequests
  if (pQuotient < maxAsyncRequests) {
    throw new Error(
      `Each process has ${pQuotient} targets, but ${maxAsyncRequests} are needed.`
    );
  }
  console.log(
    `Each process has ${pQuotient} targets (of ${targets.length}) (need at least ${maxAsyncRequests}).`
  );
  console.log(
    `Process ${processIndex}/${processCount} has ${myTargets.length} targets (indices [${myTargetStartIndexIncl}, ${myTargetEndIndexExcl}[)`
  );

  return {
    next: 0,
    targets: myTargets,
  };
}

async function generateNonConflictingN3PatchData(
  processIndex: number,
  userId: number,
  maxAsyncRequests: number,
  requestId: number,
  storage: N3PatchGeneratorState
): Promise<ArrayBuffer> {
  const index = storage.next;
  storage.next = storage.next + 1;
  if (storage.next >= storage.targets.length) {
    storage.next = 0;
  }
  console.assert(maxAsyncRequests <= storage.targets.length);

  const target = storage.targets[index];

  const quadToStr = (
    subject: RDF.Quad_Subject,
    predicate: RDF.Quad_Predicate,
    object: RDF.Quad_Object
  ): string => {
    const writer = new N3.Writer({
      format: "text/n3",
    });
    writer.addQuad(subject, predicate, object);
    let res: string | undefined;
    writer.end((error, result) => {
      res = result;
    });
    return res!.trim();
  };

  //N3 PATCH example:
  //
  //   @prefix solid: <http://www.w3.org/ns/solid/terms#>.
  //   @prefix prop: <http://nl.dbpedia.org/property/>.
  //
  //   _:rename a solid:InsertDeletePatch;
  //     solid:where   { ?infobox prop:something "MATCHING_OTHERPROP_VALUE". };
  //     solid:inserts { ?infobox prop:name newValue. };
  //     solid:deletes { ?infobox prop:name oldValue. }.

  // let newValue = `Some Random Value ${Math.floor(
  //     Math.random() * 1000.0
  // )} ${Math.floor(Math.random() * 1000.0)}`;
  const newValue = `PerfTest PATCH test process=${processIndex} requestId=${requestId} userId=${userId}`;

  const v = variable("infobox");

  const res = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.

_:rename a solid:InsertDeletePatch;
  solid:where   { ${quadToStr(v, target.matchPredicate, target.matchObject)} };
  solid:inserts { ${quadToStr(v, target.changePredicate, literal(newValue))} };
  solid:deletes { ${quadToStr(
    v,
    target.changePredicate,
    target.changeOldValue
  )} }.`;

  // console.log(`n3Patch`, res);

  target.changeOldValue = literal(newValue);

  return new Uint8Array(Buffer.from(res!, "utf8"));
}

export async function stepFlood(
  authFetchCache: AuthFetchCache,
  cli: CliArgs,
  counter: Counter,
  allFetchStartEnd: { start: number | null; end: number | null },
  processIndex: number
) {
  const n3PatchStorage = await prepareN3PatchGenerator(
    cli.n3PatchGenFilename!,
    processIndex,
    cli.processCount,
    cli.parallel
  );
  const uploadData:
    | ((userId: number, requestId: number) => Promise<ArrayBuffer>)
    | undefined =
    cli.scenario == "N3_PATCH"
      ? (userId: number, requestId: number) =>
          generateNonConflictingN3PatchData(
            processIndex,
            userId,
            cli.parallel,
            requestId,
            n3PatchStorage
          )
      : cli.mustUpload
      ? async (userId: number, requestId: number) =>
          generateUploadData(cli.httpVerb, cli.uploadSizeByte)
      : undefined;

  const requests = [];
  const promises = [];

  if (cli.durationS) {
    const durationMillis = cli.durationS * 1000;

    //Execute as many fetches as needed to fill the requested time.
    let curUserId = 0;
    const fetchIndexForUser: number[] = Array(cli.userCount).fill(
      cli.filenameIndexingStart
    );

    const requestMaker = () => {
      const userId = curUserId++;
      if (curUserId >= cli.userCount) {
        curUserId = 0;
      }
      const fetchIndex = fetchIndexForUser[userId]++;
      return fetchPodFile(
        cli.scenario,
        userId,
        cli.podFilename,
        counter,
        authFetchCache,
        cli.fetchTimeoutMs,
        cli.httpVerb,
        cli.filenameIndexing,
        fetchIndex,
        cli.cssBaseUrl,
        cli.mustUpload,
        uploadData ? uploadData(userId, fetchIndex) : undefined
      );
    };
    console.log(
      `Fetching files from ${cli.userCount} users. Max ${cli.parallel} parallel requests. Will stop after ${cli.durationS} seconds...`
    );
    allFetchStartEnd.start = Date.now();
    for (let p = 0; p < cli.parallel; p++) {
      promises.push(
        Promise.race([
          awaitUntilDeadline(
            requestMaker,
            allFetchStartEnd.start,
            durationMillis
          ),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("timeout")),
              durationMillis + 5_000
            )
          ),
        ])
      );
    }
    await Promise.allSettled(promises);
    allFetchStartEnd.end = Date.now();
    const runMillis = allFetchStartEnd.end - allFetchStartEnd.start;
    console.log(`All fetches completed after ${runMillis / 1000.0} seconds.`);
    if (runMillis < durationMillis) {
      console.error(
        `ERROR: Fetches completed too early!\n    runtime=${runMillis} ms\n    requested duration=${cli.durationS} s (=${durationMillis} ms)\n`
      );
      process.exit(1);
    }
  } else {
    //Execute all requested fetches, no matter how long it takes.
    for (
      let i = cli.filenameIndexingStart;
      i < cli.filenameIndexingStart + cli.fetchCount;
      i++
    ) {
      for (let j = 0; j < cli.userCount; j++) {
        requests.push(() =>
          fetchPodFile(
            cli.scenario,
            j,
            cli.podFilename,
            counter,
            authFetchCache,
            cli.fetchTimeoutMs,
            cli.httpVerb,
            cli.filenameIndexing,
            i,
            cli.cssBaseUrl,
            cli.mustUpload,
            uploadData ? uploadData(j, i) : undefined
          )
        );
      }
    }
    for (let p = 0; p < cli.parallel; p++) {
      promises.push(awaitUntilEmpty(requests));
    }
    console.log(
      `Fetching ${cli.fetchCount} files from ${cli.userCount} users (= ${
        cli.fetchCount * cli.userCount
      } fetches). Max ${cli.parallel} parallel requests...`
    );
    allFetchStartEnd.start = Date.now();
    await Promise.allSettled(promises);
    allFetchStartEnd.end = Date.now();
    const runMillis = allFetchStartEnd.end - allFetchStartEnd.start;
    console.log(
      `All ${cli.fetchCount} fetches completed after ${
        runMillis / 1000.0
      } seconds.`
    );
  }
}

export async function runNamedStep(
  stepName: StepName,
  authFetchCache: AuthFetchCache,
  cli: CliArgs,
  counter: Counter,
  allFetchStartEnd: { start: number | null; end: number | null }
) {
  const stepStart = new Date().getTime();

  switch (stepName) {
    case "loadAC": {
      if (cli.authCacheFile && fs.existsSync(cli.authCacheFile)) {
        await stepLoadAuthCache(
          authFetchCache,
          cli.authCacheFile,
          cli.userCount
        );
      }
      break;
    }
    case "fillAC": {
      await authFetchCache.preCache(
        cli.userCount,
        cli.ensureAuthExpirationS + 30
      );
      console.log(`Auth cache now has '${authFetchCache.toCountString()}'`);
      break;
    }
    case "validateAC": {
      authFetchCache.validate(cli.userCount, cli.ensureAuthExpirationS);
      break;
    }
    case "testRequest": {
      await authFetchCache.test(
        1,
        cli.cssBaseUrl,
        cli.podFilename,
        cli.fetchTimeoutMs
      );
      break;
    }
    case "testRequests": {
      await authFetchCache.test(
        cli.userCount,
        cli.cssBaseUrl,
        cli.podFilename,
        cli.fetchTimeoutMs
      );
      break;
    }
    case "saveAC": {
      if (cli.authCacheFile) {
        await authFetchCache.save(cli.authCacheFile);
      }
      break;
    }
    case "flood": {
      console.assert(cli.processCount < 2);
      await stepFlood(authFetchCache, cli, counter, allFetchStartEnd, 0);
      break;
    }
    default: {
      throw new Error(`Unknown step ${stepName}`);
    }
  }

  const stepStop = new Date().getTime();
  console.log(`${stepName} took '${(stepStop - stepStart) / 1000.0} seconds'`);
}
