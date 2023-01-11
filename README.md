# CSS Flood

## What?

A CLI tool to flood a CSS with requests, for testing/benchmarking.

## Why?

To evaluate/test/benchmark the [Community Solid Server (CSS)](https://github.com/CommunitySolidServer/CommunitySolidServer), we need to generate realistic load on it.

You could use existing tools like [artillery](https://www.artillery.io/) to generate this load, but they are limited in what they can do, and are not made with CSS testing in mind.

This tool is more specific:
- It uses solid specific and CSS specific authentication, and can read/write this authentication from a cache file. This auth caching can also be done separately, to prepare for later testing.
- This tool will emulate a specific number of users, each doing back-to-back requests. It can either do this for a certain period of time, or a number of requests.
- This tool generates reports with the specific statistics we need.

## How



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
$ css-flood --help
Options:
      --version  Show version number                                   [boolean]
  -u, --url      Base URL of the CSS                         [number] [required]
  -c, --count    Number of fetches per user                  [number] [required]
  -u, --users    Number of users                             [number] [required]
      --help     Show help                                             [boolean]

```

# License

This code is copyrighted by [Ghent University – imec](http://idlab.ugent.be/) and released under the [MIT license](http://opensource.org/licenses/MIT).
