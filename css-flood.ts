#!/usr/bin/env ts-node

import yargs from 'yargs'
import {hideBin} from "yargs/helpers";
import fetch from 'node-fetch';

const argv = yargs(hideBin(process.argv))
    .option('url', {
        alias: 'u',
        type: 'string',
        description: 'Base URL of the CSS',
        demandOption: true
    })
    .option('duration', {
        alias: 'fc',
        type: 'number',
        description: 'Total duration (in seconds) of the test. After this time, no new fetches are done. ' +
            'If this option is used, --fetch-count is ignored.' +
            'Default: run until all requested fetches are done.',
        demandOption: false,
    })
    .option('fetchCount', {
        alias: 'fc',
        type: 'number',
        description: 'Number of fetches per user',
        demandOption: false,
        default: 10,
    })
    .option('parallel', {
        alias: 'pc',
        type: 'number',
        description: 'Number of fetches in parallel',
        demandOption: false,
        default: 10,
    })
    .option('userCount', {
        alias: 'uc',
        type: 'number',
        description: 'Number of users',
        demandOption: false,
        default: 10,
    })
    .option('filename', {
        alias: 'f',
        type: 'string',
        description: 'File to download from pod',
        default: 'dummy.txt',
    })
    .help()
    .parseSync();

const cssBaseUrl = argv.url.endsWith('/') ? argv.url : argv.url+'/';
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
}

async function fetchPodFile(account: string, podFileRelative: string, counter: Counter) {
    // console.log(`   Will fetch file from account ${account}, pod path "${podFileRelative}"`);
    counter.total++;
    try {
        const res = await fetch(`${cssBaseUrl}${account}/${podFileRelative}`, {
            method: 'GET',
            //open bug in nodejs typescript that AbortSignal.timeout doesn't work
            //  see https://github.com/node-fetch/node-fetch/issues/741
            // @ts-ignore
            signal: AbortSignal.timeout(4_000),  // abort after 4 seconds //supported in nodejs>=17.3
        });

    // console.log(`res.ok`, res.ok);
    // console.log(`res.status`, res.status);
        const body = await res.text();
        counter.statuses[res.status] = (counter.statuses[res.status] || 0) + 1;

        if (!res.ok) {
            const errorMessage = `${res.status} - Fetching from account ${account}, pod path "${podFileRelative}" failed: ${body}`
            console.error(errorMessage);
            //throw new Error(errorMessage);
            counter.failure++;
            return;
        } else {
            counter.success++;
        }
    } catch (e) {
        counter.exceptions++;
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

async function awaitUntilDeadline(actionMaker: () => Promise<void>, start: number, durationMillis: number) {
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
    const requests = [];
    const promises = [];
    let counter = new Counter();
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
            const account = `user${userId}`;
            return fetchPodFile(account, podFilename, counter);
        };
        for (let p = 0; p < parallel; p++) {
            promises.push(
                Promise.race([
                        awaitUntilDeadline(requestMaker, start, durationMillis),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('timeout')), durationMillis+5_000)
                        )
                    ]
                )
            )
        }
        console.log(`Fetching files from ${userCount} users. Max ${parallel} parallel requests. Will stop after ${duration} seconds...`);
        await Promise.allSettled(promises);
        console.log(`All fetches completed after ${(Date.now() - start) / 1000.0} seconds.`);
    } else {
        //Execute all requested fetches, no matter how long it takes.
        for (let i = 0; i < fetchCount; i++) {
            for (let j = 0; j < userCount; j++) {
                const account = `user${j}`;
                requests.push(() => fetchPodFile(account, podFilename, counter));
            }
        }
        for (let p = 0; p < parallel; p++) {
            promises.push(awaitUntilEmpty(requests));
        }
        console.log(`Fetching ${fetchCount} files from ${userCount} users. Max ${parallel} parallel requests...`);
        await Promise.allSettled(promises);
        console.log(`All fetches completed.`);
    }
    console.log(`Fetch Statistics: total=${counter.total} success=${counter.success} failure=${counter.failure} exceptions=${counter.exceptions} statuses=${JSON.stringify(counter.statuses)}`);
}

try {
    await main();
    process.exit(0);
} catch (err) {
    console.error(err);
    process.exit(1);
}
