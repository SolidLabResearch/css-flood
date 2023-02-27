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
import { CliArgs, StepName } from "./css-flood-args.js";
import { FloodStatistics } from "./css-flood-steps.js";

export interface WorkerAnnounce {
  messageType: "WorkerAnnounce";
  pid: number;
}

export interface ReportStepDone {
  messageType: "ReportStepDone";
}

export interface ReportFloodStatistics {
  messageType: "ReportFloodStatistics";
  statistics: FloodStatistics;
}

export interface SetCliArgs {
  messageType: "SetCliArgs";
  cliArgs: CliArgs;
  processFetchCount: number; //cliArgs.fetchCount is fairly divided over all processes
  parallelFetchCount: number; //cliArgs.parallel is fairly divided over all processes
  index?: number; //cliArgs.filenameIndexing is divided over all processes so no duplicates are used
}

export interface SetCache {
  messageType: "SetCache";
  authCacheContent: string;
}

export interface RunStep {
  messageType: "RunStep";
  stepName: StepName;
}

export interface StopWorker {
  messageType: "StopWorker";
}

export type WorkerMsg = WorkerAnnounce | ReportStepDone | ReportFloodStatistics;

export type ControllerMsg = SetCliArgs | RunStep | SetCache | StopWorker;
