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
    .option('count', {
        alias: 'c',
        type: 'number',
        description: 'Number of fetches per user',
        demandOption: true,
    })
    .option('users', {
        alias: 'u',
        type: 'number',
        description: 'Number of users',
        demandOption: true,
    })
    .help()
    .parseSync();

const cssBaseUrl = argv.url.endsWith('/') ? argv.url : argv.url+'/';


async function fetchPodFile(account: string, podFileRelative: string) {
    console.log(`   Will fetch file from account ${account}, pod path "${podFileRelative}"`);

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

async function main() {
    const userCount = argv.users || 1;
    const fetchCount = argv.count || 1;
    const promises = [];
    for (let i = 0; i < fetchCount; i++) {
        for (let j = 0; j < userCount; j++) {
            const account = `user${j}`;
            promises.push(fetchPodFile(account, 'dummy.txt'));
        }
    }
    console.log(`Fetching ${fetchCount} files from ${userCount} users...`);
    await Promise.all(promises);
    console.log(`All fetches completed.`);
}

try {
    await main();
    process.exit(0);
} catch (err) {
    console.error(err);
    process.exit(1);
}
