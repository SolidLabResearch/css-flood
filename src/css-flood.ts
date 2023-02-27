#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import nodeFetch from "node-fetch";
import { Response as NodeJsResponse } from "node-fetch";
import { AuthFetchCache, fromNow } from "./auth-fetch-cache.js";
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
import { getCliArgs, HttpVerb } from "./css-flood-args.js";
import {
  awaitUntilDeadline,
  awaitUntilEmpty,
  Counter,
  fetchPodFile,
  FloodStatistics,
  generateUploadData,
  reportAuthCacheStatistics,
  reportFinalStatistics,
  runNamedStep,
  stepFlood,
  stepLoadAuthCache,
  sumStatistics,
} from "./css-flood-steps.js";
import { fork } from "child_process";
import { ControllerMsg, WorkerMsg } from "./css-flood-messages.js";
import { MessageCheat } from "./message-cheat.js";

async function main() {
  const cli = getCliArgs();
  const fetcher: AnyFetchType = cli.useNodeFetch ? nodeFetch : es6fetch;

  const authFetchCache = new AuthFetchCache(
    cli.cssBaseUrl,
    cli.authenticate,
    cli.authenticateCache,
    fetcher
  );

  let counter = new Counter();
  const allFetchStartEnd: { start: number | null; end: number | null } = {
    start: null,
    end: null,
  };

  for (const stepName of cli.steps) {
    if (stepName != "flood") {
      await runNamedStep(
        stepName,
        authFetchCache,
        cli,
        counter,
        allFetchStartEnd
      );
    }
  }

  if (!cli.steps.includes("flood")) {
    await reportAuthCacheStatistics(authFetchCache, cli.reportFile);
    console.log(`--steps does not include flood: will exit now`);
    process.exit(0);
  }

  process.on("SIGINT", function () {
    console.log(`******* GOT SIGINT *****`);
    console.log(`* Fetches are still in progress...`);
    console.log(`* Dumping statistics and exiting:`);
    reportFinalStatistics(
      counter,
      allFetchStartEnd,
      authFetchCache,
      cli.reportFile
    ).finally(() => process.exit(1));
  });

  if (cli.processCount == 1) {
    await stepFlood(authFetchCache, cli, counter, allFetchStartEnd);

    await reportFinalStatistics(
      counter,
      allFetchStartEnd,
      authFetchCache,
      cli.reportFile
    );
  } else {
    console.log(`Multi process flood. Starting ${cli.processCount} workers...`);

    const msgCheat = new MessageCheat<WorkerMsg>();

    interface ProcessInfo {
      index: number;
      process: any;
      ready: boolean;
      stats: FloodStatistics | null;
      processFetchCount: number;
      parallelFetchCount: number;
      filenameIndexingStart?: number;
    }

    //create processes and wait for them
    const fRemainder = cli.fetchCount % cli.processCount;
    const fQuotient = (cli.fetchCount - fRemainder) / cli.processCount;
    const pRemainder = cli.parallel % cli.processCount;
    const pQuotient = (cli.parallel - pRemainder) / cli.processCount;

    const processes: ProcessInfo[] = [];
    let filenameIndexingStart = cli.filenameIndexingStart;
    const changeIndex = cli.filenameIndexing && !cli.durationS;
    for (let index = 0; index < cli.processCount; index++) {
      const worker_exe = new URL("./css-flood-worker", import.meta.url)
        .toString()
        .replace("file:/", "");
      const processFetchCount = fQuotient + (index < fRemainder ? 1 : 0);
      const parallelFetchCount = pQuotient + (index < pRemainder ? 1 : 0);
      if (parallelFetchCount === 0) {
        console.log(
          `Fewer parallel fetches (=${cli.parallel}) than processes (=${cli.processCount}). ` +
            `Will not start worker ${index}.`
        );
        continue;
      }
      if (processFetchCount === 0 && !cli.durationS) {
        console.log(
          `Fewer fetches (=${cli.fetchCount}) needed than processes (=${cli.processCount}). ` +
            `Will not start worker ${index}.`
        );
        continue;
      }
      const child = fork(worker_exe, []);
      const p = {
        index,
        process: child,
        ready: false,
        stats: null,
        parallelFetchCount,
        processFetchCount,
        filenameIndexingStart: changeIndex ? filenameIndexingStart : undefined,
      };
      processes.push(p);
      child.on("message", (message: WorkerMsg) =>
        msgCheat.messageCallback(message, p)
      );

      if (changeIndex) {
        filenameIndexingStart += processFetchCount;
      }
    }
    console.log(`Workers started. Waiting for ready...`);
    while (
      !processes
        .map((p) => p.ready)
        .reduce((a: boolean, b: boolean) => a && b, true)
    ) {
      const { message, context } = await msgCheat.waitForMessage();
      if (message.messageType === "WorkerAnnounce") {
        context.ready = true;
      } else {
        throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
      }
    }
    console.log(`Workers ready. Sending config...`);

    //init processes
    for (const p of processes) {
      p.process.send({
        messageType: "SetCliArgs",
        cliArgs: cli,
        processFetchCount: p.processFetchCount,
        parallelFetchCount: p.parallelFetchCount,
        index: p.filenameIndexingStart,
      });
      p.process.send({
        messageType: "SetCache",
        authCacheContent: JSON.stringify(await authFetchCache.dump()),
      });
    }
    console.log(`Workers configured. Starting flood...`);
    //run flood
    for (const p of processes) {
      p.process.send({
        messageType: "RunStep",
        stepName: "flood",
      });
    }
    //gather results and aggregate

    console.log(`Flood started. Waiting for end on all workers...`);
    while (
      !processes
        .map((p) => p.stats != null)
        .reduce((a: boolean, b: boolean) => a && b, true)
    ) {
      const { message, context } = await msgCheat.waitForMessage();
      if (message.messageType === "ReportStepDone") {
        console.log(`    ... Worker ${context.process.pid} done`);
        //ignore
      } else if (message.messageType === "ReportFloodStatistics") {
        console.log(
          `    ... Worker ${context.process.pid} reported statistics`
        );
        context.stats = message.statistics;
        if (
          typeof message?.statistics?.authFetchCache?.stats?.useCount !=
          "number"
        ) {
          throw new Error(
            `Invalid stats received: ${JSON.stringify(message.statistics)}`
          );
        }
      } else {
        throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
      }
    }
    console.log(`Flood ended on all workers. Gathering statistics...`);

    //print statistics
    const allStats: FloodStatistics[] = <FloodStatistics[]>(
      processes.map((p) => p.stats)
    );
    const aggStats = sumStatistics(allStats);
    const full = {
      ...aggStats,
      byPid: Object.fromEntries(processes.map((p) => [p.process.pid, p.stats])),
    };

    const reportContent = JSON.stringify(full);
    if (!cli.reportFile) {
      console.log("FINAL STATISTICS:\n---\n" + reportContent + "\n---\n\n");
    } else {
      console.log(`Writing report to '${cli.reportFile}'...`);
      await afs.writeFile(cli.reportFile, reportContent);
      console.log(`Report saved`);
    }
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
