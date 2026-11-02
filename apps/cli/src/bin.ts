#!/usr/bin/env node
import { USAGE_EXIT_CODE } from '@webridge/core'
import { CommanderError } from 'commander'
import { createProgram } from './index.js'

const program = createProgram(true)
program.parseAsync(process.argv).catch((e: unknown) => {
  // Usage errors: commander's own failures (unknown option, missing argument,
  // invalid value) and our own param parsing. Help/version exit 0 via the
  // commander.help and commander.version codes; everything else is usage.
  if (e instanceof CommanderError) {
    if (e.exitCode === 0) process.exit(0)
    console.error(e.message)
    process.exit(USAGE_EXIT_CODE)
  }
  console.error((e as Error).message)
  process.exit(1)
})
