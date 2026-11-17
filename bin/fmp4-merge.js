#!/usr/bin/env node
import { reportError, run } from "../src/cli.js";

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  if (!reportError(error)) {
    console.error(error.stack || error.message);
  }
  process.exitCode = 1;
}
