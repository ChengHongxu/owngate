#!/usr/bin/env node
import { createProgram } from './index.js'

const program = createProgram()
program.parseAsync(process.argv).catch((e: unknown) => {
  console.error((e as Error).message)
  process.exit(1)
})
