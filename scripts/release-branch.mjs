#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const noPush = process.argv.includes("--no-push")

function fail(message) {
    console.error(`release branch failed: ${message}`)
    process.exit(1)
}

function git(...args) {
    return execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
    }).trim()
}

function run(command, args) {
    execFileSync(command, args, {
        cwd: root,
        stdio: "inherit",
    })
}

const branch = git("branch", "--show-current")
if (branch !== "master") {
    fail(`switch to master before releasing (currently on ${branch || "detached HEAD"})`)
}

const dirty = git("status", "--porcelain", "--untracked-files=normal")
if (dirty) {
    fail(`working tree must be clean before releasing:\n${dirty}`)
}

const source = git("rev-parse", "--short", "HEAD")

console.log(`Building release branch from master (${source})...`)

let switched = false
try {
    run("git", ["switch", "-C", "release", "master"])
    switched = true

    run("npm", ["run", "check:package"])
    run("git", ["add", "-f", "dist"])
    run("git", ["commit", "--quiet", "-m", `build: ${source}`])

    const release = git("rev-parse", "--short", "HEAD")
    if (noPush) {
        console.log(`Updated local release branch at ${release}; not pushed (--no-push).`)
    } else {
        run("git", ["push", "--force", "origin", "release"])
        console.log(`Published release branch at ${release}.`)
    }
} finally {
    if (switched) {
        try {
            run("git", ["switch", "master"])
        } catch {
            console.error("warning: could not switch back to master")
        }
    }
}
