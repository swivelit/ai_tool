#!/usr/bin/env node

// Thin developer wrapper around the same diagnostic shipped by `swico`.
// It deliberately exits non-zero unless native readiness is genuinely proved.
import { diagnoseMacSandbox } from '../dist/sandbox.js'

const report = diagnoseMacSandbox()
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.native_ready ? 0 : 1
