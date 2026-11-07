#!/usr/bin/env node
import { USAGE_EXIT_CODE } from '@owngate/core'
import { CommanderError } from 'commander'
import { createProgram } from './index.js'
import { reportCliFailure } from './diagnostics.js'
import { CliUsageError } from './errors.js'

const program = createProgram(true)
program.parseAsync(process.argv).catch((e: unknown) => {
  // Usage errors: commander's own failures (unknown option, missing argument,
  // invalid value) and our own param parsing. Help/version exit 0 via the
  // commander.help and commander.version codes; everything else is usage.
  if (e instanceof CommanderError) {
    if (e.exitCode === 0) process.exit(0)
    // Commander already wrote the user-facing error. Its internal message
    // (including `(outputHelp)`) is not an additional diagnostic.
    process.exit(USAGE_EXIT_CODE)
  }
  if (e instanceof CliUsageError) process.exitCode = reportCliFailure(e)
  else {
    // Offline recovery errors contain necessary, operation-specific recovery
    // steps, so retain them rather than describing them as network failures.
    console.error(e instanceof Error ? e.message : '命令执行失败。')
    process.exitCode = 1
  }
})
