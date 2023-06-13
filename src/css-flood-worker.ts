#!/usr/bin/env node

import { ControllerMsg, WorkerMsg } from "./css-flood-messages.js";
import { CliArgs, getCliArgs } from "./css-flood-args.js";
import { AnyFetchType, es6fetch } from "./generic-fetch.js";
import nodeFetch from "node-fetch";
import { AuthFetchCache } from "./auth-fetch-cache.js";
import {
  Counter,
  makeStatistics,
  runNamedStep,
  stepFlood,
} from "./css-flood-steps.js";
import { MessageCheat } from "./message-cheat.js";

async function main() {
  if (!process.send) {
    console.error(
      "Don't call this directly! css-flood-worker should be spawned as child process of css-flood."
    );
    process.exit(1);
  }

  process.send({
    messageType: "WorkerAnnounce",
    pid: process.pid,
  });

  //help us handle messages in async way
  const msgCheat = new MessageCheat<ControllerMsg>();
  process.on("message", (message: ControllerMsg) =>
    msgCheat.messageCallback(message)
  );

  //handle messages
  let stopped = false;
  let processIndex: number | undefined = undefined;
  let cli: CliArgs | null = null;
  let fetcher: AnyFetchType | null = null;
  let authFetchCache: AuthFetchCache | null = null;
  let counter = new Counter();
  const allFetchStartEnd: { start: number | null; end: number | null } = {
    start: null,
    end: null,
  };

  while (!stopped) {
    const { message } = await msgCheat.waitForMessage();
    // console.debug(
    //   `Worker ${process.pid} got message of type '${message.messageType}'`
    // );
    switch (message.messageType) {
      case "SetCliArgs": {
        cli = message.cliArgs;
        fetcher = cli.useNodeFetch ? nodeFetch : es6fetch;
        //override fetchCount with the part of the fetchCount for this process
        // console.debug(
        //   `Overriding for process ${process.pid}: ` +
        //     `fetchCount=${message.processFetchCount} instead of ${cli.fetchCount}`
        // );
        // console.debug(
        //   `Overriding for process ${process.pid}: ` +
        //     `  parallel=${message.parallelFetchCount} instead of ${cli.parallel}`
        // );
        cli.fetchCount = message.processFetchCount;
        cli.parallel = message.parallelFetchCount;
        if (typeof message.index === "number") {
          // console.debug(
          //   `Overriding for process ${process.pid}: ` +
          //     `  filenameIndexingStart=${message.index} instead of ${cli.filenameIndexingStart}`
          // );
          cli.filenameIndexingStart = message.index;
        }
        processIndex = message.processIndex;
        break;
      }
      case "SetCache": {
        if (cli == null || fetcher == null) {
          throw new Error(`SetCache called before SetCliArgs`);
        }
        authFetchCache = new AuthFetchCache(
          cli.cssBaseUrl,
          cli.authenticate,
          cli.authenticateCache,
          fetcher
        );
        console.assert(authFetchCache.authAccessTokenByUser !== null);
        await authFetchCache.loadString(message.authCacheContent);
        // await authFetchCache.validate(cli.userCount, cli.ensureAuthExpirationS);
        break;
      }
      case "RunStep": {
        try {
          if (cli == null || fetcher == null || authFetchCache == null) {
            throw new Error(`RunStep called before SetCliArgs and/or SetCache`);
          }
          console.assert(authFetchCache.authAccessTokenByUser !== null);
          if (message.stepName != "flood") {
            await runNamedStep(
              message.stepName,
              authFetchCache,
              cli,
              counter,
              allFetchStartEnd
            );
          } else {
            // await authFetchCache.validate(
            //   cli.userCount,
            //   cli.ensureAuthExpirationS
            // );
            if (typeof processIndex !== "number") {
              throw new Error(
                `processIndex not set correctly: ${processIndex}`
              );
            }
            // console.debug(`Worker ${process.pid}: flood start`);
            try {
              await stepFlood(
                authFetchCache,
                cli,
                counter,
                allFetchStartEnd,
                processIndex
              );
            } finally {
              const floodStatistics = makeStatistics(
                counter,
                allFetchStartEnd,
                authFetchCache
              );
              // @ts-ignore this should not happen, we checked this at start
              process.send({
                messageType: "ReportFloodStatistics",
                statistics: floodStatistics,
              });
            }
          }
        } finally {
          // @ts-ignore this should not happen, we checked this at start
          process.send({
            messageType: "ReportStepDone",
          });
        }
        break;
      }
      case "StopWorker": {
        stopped = true;
        break;
      }
      default: {
        // @ts-ignore
        throw new Error(`Unknown msg ${message.messageType}`);
      }
    }
  }

  console.log(`Worker ${process.pid} is exiting.`);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(err);
  process.exit(1);
}
