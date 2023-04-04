# CSS Flood

## What?

A CLI tool to flood a CSS with requests, for testing/benchmarking.

## Why?

To evaluate/test/benchmark the [Community Solid Server (CSS)](https://github.com/CommunitySolidServer/CommunitySolidServer), we need to generate realistic load on it.

You could use existing tools like [artillery](https://www.artillery.io/) to generate this load, but they are limited in what they can do, and are not made with CSS testing in mind.

This tool has a more limited scope, which allows it to do things artillery can't (easily) do, and to do them with little or no config.

## How?

- `css-flood` uses solid specific and CSS specific authentication, and can read/write this authentication from a cache file. This auth caching can also be done separately, to prepare for later testing.
- `css-flood` will emulate a specific number of users, each doing back-to-back requests. It can either do this for a certain period of time, or a number of requests.
- `css-flood` generates a report when it's done. This report contains the custom statistics.

## Install

Install:

```
npm install
npm run build
npm link
css-flood --help
```

## Usage

Help:

```
Usage: css-flood.js --url <url> [--steps <steps>] ...

Base:
  --url         Base URL of the CSS                                                                  [string] [required]
  --steps       The steps that need to run, as a comma separated list. See below for more details.
                                                                                             [string] [default: "flood"]
  --reportFile  File to save report to (JSON format). Of not specified, the report is sent to stdout like the other outp
                ut.                                                                                             [string]

Fetcher Setup:
  --duration      Total duration (in seconds) of the flood. After this time, no new fetches are done. If this option is
                  used, --fetchCount is ignored.Default: run until all requested fetches are done.              [number]
  --fetchCount    Number of fetches per user during the flood.                                    [number] [default: 10]
  --parallel      Number of fetches in parallel during the flood.                                 [number] [default: 10]
  --processCount  Number of client processes to run in parallel. (Fetches and parallel fetches are distributed evenly be
                  tween these processes.)                                                          [number] [default: 1]
  --userCount     Number of users                                                                 [number] [default: 10]

Fetch Action:
  --fetchTimeoutMs         How long before aborting a fetch because it takes too long? (in ms)  [number] [default: 4000]
  --filename               Remote file to download from pod, or filename of file to upload to pod
                                                                                            [string] [default: "10.rnd"]
  --filenameIndexing       Replace the literal string 'INDEX' in the filename for each action (upload/download). This wa
                           y, each fetch uses a unique filename. Index will start from 0 (change with --filenameIndexing
                           Start) and increment.                                              [boolean] [default: false]
  --filenameIndexingStart  Set the index that --filenameIndexing starts with                       [number] [default: 0]
  --uploadSizeByte         Number of bytes of (random) data to upload for POST/PUT                [number] [default: 10]
  --verb                   HTTP verb to use for the flood: GET/PUT/POST/DELETE
                                                     [string] [choices: "GET", "PUT", "POST", "DELETE"] [default: "GET"]
  --scenario               Fetch scenario: what sort of fetch action is this? BASIC is a simple file upload/download/del
                           ete.
                         [string] [choices: "BASIC", "CONTENT_TRANSLATION", "NO_CONTENT_TRANSLATION"] [default: "BASIC"]

Fetch Authentication:
  --authenticate          Authenticated as the user owning the target file                    [boolean] [default: false]
  --authenticateCache     How much authentication should be cached? All authentication (=all)? Only the CSS user token (
                          =token)? Or no caching (=none)?    [string] [choices: "none", "token", "all"] [default: "all"]
  --authCacheFile         File to load/save the authentication cache from/to                                    [string]
  --ensureAuthExpiration  fillAC and validateAC will ensure the authentication cache content is still valid for at least
                           this number of seconds                                                 [number] [default: 90]

Advanced:
  --fetchVersion  Use node-fetch or ES6 fetch (ES6 fetch is only available for nodejs versions >= 18)
                                                                     [string] [choices: "node", "es6"] [default: "node"]

Options:
  --version  Show version number                                                                               [boolean]
  --help     Show help                                                                                         [boolean]

Details for --steps:

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
- testRequest: Do 1 request (typically a GET to download a file) for the first user.
               This tests both the data in the authentication cache (adding missing entries), and the actual request.
- testRequests: Do 1 request (typically a GET to download a file) for each users (back-to-back, not in parallel).
                This tests both the data in the authentication cache (adding missing entries), and the actual request.
- saveAC: Save the authentication cache to file.
- flood: Run the actual "flood": generate load on the target CSS by running a number of requests in parallel.

Examples:
--steps 'loadAC,validateAC,flood'
--steps 'fillAC,saveAC'
--steps 'loadAC,fillAC,saveAC'
--steps 'loadAC,testRequest,saveAC,flood'

All steps (makes little sense):
--steps 'loadAC,fillAC,validateAC,testRequest,testRequests,saveAC,flood'

```

# License

This code is copyrighted by [Ghent University – imec](http://idlab.ugent.be/) and released under the [MIT license](http://opensource.org/licenses/MIT).
