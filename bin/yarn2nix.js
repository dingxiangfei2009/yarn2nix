#!/usr/bin/env node
"use strict";

const crypto = require('crypto');
const child_process = require('child_process');
const fs = require("fs");
const https = require("https");
const path = require("path");
const url = require("url");
const util = require("util");

const exec = util.promisify(child_process.exec);

const lockfile = require("@yarnpkg/lockfile")
const docopt = require("docopt").docopt;
const equal = require("deep-equal");

////////////////////////////////////////////////////////////////////////////////

const USAGE = `
Usage: yarn2nix [options]

Options:
  -h --help        Shows this help.
  --no-nix         Hide the nix output
  --no-patch       Don't patch the lockfile if hashes are missing
  --lockfile=FILE  Specify path to the lockfile [default: ./yarn.lock].
`

const HEAD = `
{fetchgitTarball, fetchurl, linkFarm}: rec {
  offline_cache = linkFarm "offline" packages;
  packages = [
`.trim();

////////////////////////////////////////////////////////////////////////////////

function is_https_git(url) {
  if (url.match(/^git\+https:\/\//)) {
    return { url: url.substr(4) };
  } else if (url.match(/\.git$/)) {
    return { url };
  }
}

function generateNix(lockedDependencies) {
  let found = new Set;

  console.log(HEAD)

  for (var depRange in lockedDependencies) {
    let dep = lockedDependencies[depRange];

    let namespaceMatch = depRange.match(/(^@\w+)\//);
    let namespace = namespaceMatch ? `${namespaceMatch[1]}-` : "";

    if (!dep.resolved) continue;
    let [pkg_url, sha1] = dep.resolved.split("#");
    let file_name = path.basename(url.parse(pkg_url).pathname);
    let https_git_url = is_https_git(pkg_url);
    let cache_file_name = https_git_url ? `${file_name}-${sha1}` : file_name;
    let full_file_name = `${namespace}${cache_file_name}`;
    if (found.has(full_file_name)) {
      continue;
    } else {
      found.add(full_file_name);
    }

    let src_nix_expr = https_git_url ?
      `
      fetchgitTarball "${file_name}" {
        url = "${https_git_url.url}";
        rev = "${sha1}";
        sha256 = "${dep.sha256}";
      }
      ` :
      `
      fetchurl {
        name = "${file_name}";
        url  = "${pkg_url}";
        sha1 = "${sha1}";
      }
      `

    console.log(`
    {
      name = "${full_file_name}";
      path = ${src_nix_expr};
    }`)
  }

  console.log("  ];")
  console.log("}")
}


function getSha1(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const { statusCode } = res;
      const hash = crypto.createHash('sha1');
      if (statusCode !== 200) {
        const err = new Error('Request Failed.\n' +
                          `Status Code: ${statusCode}`);
        // consume response data to free up memory
        res.resume();
        reject(err);
      }

      res.on('data', (chunk) => { hash.update(chunk); });
      res.on('end', () => { resolve(hash.digest('hex')) });
      res.on('error', reject);
    });
  });
};

async function getGitSha1(url, rev) {
  const { stdout, stderr } = await exec(`nix-prefetch-git --quiet ${url} ${rev}`);
  const { sha256 } = JSON.parse(stdout);
  return sha256;
}

async function updateResolvedSha1(pkg) {
  // local dependency
  if (!pkg.resolved) { return ; }
  let [url, sha1] = pkg.resolved.split("#", 2);
  let https_git_url = is_https_git(url);

  if (!sha1) {
    let pkg_sha1 = await getSha1(url);
    pkg.resolved = "${url}#${pkg_sha1}";
  } else if (https_git_url) {
    let pkg_sha256 = await getGitSha1(https_git_url.url, sha1);
    pkg.sha256 = pkg_sha256;
  }
}

function values(obj) {
  var entries = [];
  for (let key in obj) {
    entries.push(obj[key]);
  }
  return entries;
}

////////////////////////////////////////////////////////////////////////////////
// Main
////////////////////////////////////////////////////////////////////////////////

var options = docopt(USAGE);

let data = fs.readFileSync(options['--lockfile'], 'utf8')
let json = lockfile.parse(data)
if (json.type != "success") {
  throw new Error("yarn.lock parse error")
}

// Check fore missing hashes in the yarn.lock and patch if necessary
var pkgs = values(json.object);
Promise.all(pkgs.map(updateResolvedSha1)).then(() => {
  let origJson = lockfile.parse(data)

  if (!equal(origJson, json)) {
    console.error("found changes in the lockfile", options["--lockfile"]);

    if (options["--no-patch"]) {
      console.error("...aborting");
      process.exit(1);
    }

    fs.writeFileSync(options['--lockfile'], lockfile.stringify(json.object));
  }

  if (!options['--no-nix']) {
    generateNix(json.object);
  }
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
