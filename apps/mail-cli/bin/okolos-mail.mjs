#!/usr/bin/env node
/**
 * `okolos-mail`: the file `package.json` names as the command. Plain
 * JavaScript, so every node the root `engines` allows reaches the refusal in
 * `src/launch.mjs` instead of rejecting the file; it calls the command
 * unconditionally and ends with 2 when it cannot (B-161).
 */
import process from 'node:process'

import { launch } from '../src/launch.mjs'

const code = await launch({ argv: process.argv.slice(2), env: process.env })
if (code !== undefined) process.exitCode = code
