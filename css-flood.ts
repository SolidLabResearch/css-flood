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

async function fetchPodFile(account: string, podFileRelative: string) {
    // console.log(`   Will fetch file from account ${account}, pod path "${podFileRelative}"`);

    const res = await fetch(`${cssBaseUrl}${account}/${podFileRelative}`, {
        method: 'GET',
    });

    // console.log(`res.ok`, res.ok);
    // console.log(`res.status`, res.status);
    const body = await res.text();
    // console.log(`res.text`, body);
    if (!res.ok) {
        const errorMessage = `${res.status} - Fetching from account ${account}, pod path "${podFileRelative}" failed: ${body}`
        console.error(errorMessage);
        throw new Error(errorMessage);
    }
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
    if (duration) {
        const durationMillis = duration * 1000;
        const start = Date.now();

        //Execute as many fetches as needed to fill the requested time.
        let curUserId = 0;
        let fetchCount = 0;
        const requestMaker = () => {
            const userId = curUserId++;
            if (curUserId >= userCount) {
                curUserId = 0;
            }
            const account = `user${userId}`;
            fetchCount++;
            return fetchPodFile(account, podFilename);
        };
        for (let p = 0; p < parallel; p++) {
            promises.push(awaitUntilDeadline(requestMaker, start, durationMillis));
        }
        console.log(`Fetching files from ${userCount} users. Max ${parallel} parallel requests. Will stop after ${duration} seconds...`);
        await Promise.allSettled(promises);
        console.log(`All fetches completed: count=${fetchCount}`);
    } else {
        //Execute all requested fetches, no matter how long it takes.
        for (let i = 0; i < fetchCount; i++) {
            for (let j = 0; j < userCount; j++) {
                const account = `user${j}`;
                requests.push(() => fetchPodFile(account, podFilename));
                // promises.push(fetchPodFile(account, 'dummy.txt'));
            }
        }
        for (let p = 0; p < parallel; p++) {
            promises.push(awaitUntilEmpty(requests));
        }
        console.log(`Fetching ${fetchCount} files from ${userCount} users. Max ${parallel} parallel requests...`);
        await Promise.allSettled(promises);
        console.log(`All fetches completed.`);
    }
}

try {
    await main();
    process.exit(0);
} catch (err) {
    console.error(err);
    process.exit(1);
}
