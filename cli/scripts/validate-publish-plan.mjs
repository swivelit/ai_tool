#!/usr/bin/env node

import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const MAX_IDENTITY_BYTES = 16 * 1024

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

function arg(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return process.argv[index + 1]
}

export function parsePackageMetadata(text, packageName) {
  const value = JSON.parse(text)
  if (!value || value.name !== packageName || typeof value.version !== 'string') {
    throw new Error('npm latest package identity is invalid')
  }
  return { name: value.name, version: value.version }
}

export function parsePublishedPackageIdentity({ packageJsonText, identityText, packageName }) {
  const pkg = JSON.parse(packageJsonText)
  if (pkg.name !== packageName || pkg.bin?.swico !== 'dist/cli.js') {
    throw new Error('published package identity is invalid')
  }
  if (Buffer.byteLength(identityText, 'utf8') > MAX_IDENTITY_BYTES) {
    throw new Error('published build identity is unexpectedly large')
  }
  const match = identityText.match(/Object\.freeze\((\{[^\n]{1,8192}\})\)/)
  if (!match) throw new Error('published build identity is missing')
  const identity = JSON.parse(match[1])
  if (!/^[0-9a-f]{40,64}$/.test(identity.revision) || identity.dirty !== false) {
    throw new Error('published build identity is invalid')
  }
  return { version: pkg.version, revision: identity.revision }
}

export function validateExistingTarget({ responseText, packageName, targetVersion }) {
  const actual = JSON.parse(responseText)
  if (actual.name !== packageName || actual.version !== targetVersion) {
    throw new Error('existing npm target has an unexpected package identity')
  }
  return true
}

export function printPlan(plan) {
  const lines = [plan.reason]
  if (plan.changedPaths?.length) {
    lines.push(`Release-worthy changes: ${plan.changedPaths.join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}

function main() {
  const mode = process.argv[2]
  if (mode === 'metadata') {
    const result = parsePackageMetadata(fs.readFileSync(arg('--input'), 'utf8'), arg('--package'))
    fs.writeFileSync(arg('--output'), JSON.stringify(result))
    return
  }
  if (mode === 'identity') {
    const result = parsePublishedPackageIdentity({
      packageJsonText: fs.readFileSync(arg('--package-json'), 'utf8'),
      identityText: fs.readFileSync(arg('--identity'), 'utf8'),
      packageName: arg('--package'),
    })
    fs.writeFileSync(arg('--output'), JSON.stringify(result))
    return
  }
  if (mode === 'target') {
    validateExistingTarget({
      responseText: fs.readFileSync(arg('--input'), 'utf8'),
      packageName: arg('--package'),
      targetVersion: arg('--version'),
    })
    return
  }
  if (mode === 'print-plan') {
    process.stdout.write(printPlan(readJson(arg('--input'))))
    return
  }
  if (mode === 'version') {
    const pkg = readJson(arg('--package-json'))
    const lock = readJson(arg('--lockfile'))
    const expected = arg('--version')
    if (pkg.name !== '@swiveltechnologies/swico' || pkg.bin?.swico !== 'dist/cli.js') throw new Error('CLI package identity changed')
    if (pkg.version !== expected || lock.version !== expected || lock.packages?.['']?.version !== expected) throw new Error('package and lock versions do not match')
    return
  }
  if (mode === 'manifest') {
    const manifest = readJson(arg('--manifest'))
    const expected = {
      package: '@swiveltechnologies/swico',
      version: arg('--version'),
      git_revision: arg('--revision'),
      dirty: false,
      artifact_filename: arg('--tarfile-name'),
    }
    for (const [key, value] of Object.entries(expected)) if (manifest[key] !== value) throw new Error(`manifest ${key} mismatch`)
    const sha = crypto.createHash('sha256').update(fs.readFileSync(arg('--tarfile'))).digest('hex')
    if (manifest.sha256 !== sha) throw new Error('manifest SHA-256 does not match the tarball')
    return
  }
  throw new Error('Usage: validate-publish-plan.mjs <metadata|identity|target|print-plan|version|manifest> ...')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
