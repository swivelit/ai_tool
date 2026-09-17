import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandUsageError, parseInteractiveCommand, validateTopLevelArguments } from '../dist/command_registry.js'
import { errorDetails } from '../dist/api.js'
import { formatUsage } from '../dist/usage.js'

test('unknown slash commands are rejected by exact token matching', () => {
  for (const value of ['/exite', '/bogus', '/usagex', '/searchlight']) {
    assert.throws(() => parseInteractiveCommand(value), CommandUsageError)
  }
  assert.deepEqual(parseInteractiveCommand('/search on'), { kind:'command', name:'search', argument:'on' })
  assert.deepEqual(parseInteractiveCommand('/image /tmp/path with spaces.png'), { kind:'command', name:'image', argument:'/tmp/path with spaces.png' })
  assert.deepEqual(parseInteractiveCommand('/agent inspect the repository'), { kind:'command', name:'agent', argument:'inspect the repository' })
  assert.deepEqual(parseInteractiveCommand('/resume session-123'), { kind:'command', name:'resume', argument:'session-123' })
  assert.deepEqual(parseInteractiveCommand('/resume'), { kind:'command', name:'resume' })
  assert.deepEqual(parseInteractiveCommand('/ask /literal text'), { kind:'command', name:'ask', argument:'/literal text' })
  assert.deepEqual(parseInteractiveCommand('/exit'), { kind:'command', name:'exit' })
})

test('known interactive command arguments fail locally instead of falling through to Chat', () => {
  for (const value of ['/exit now', '/search maybe', '/permissions unsafe', '/agent', '/image', '/resume one two']) {
    assert.throws(() => parseInteractiveCommand(value), CommandUsageError)
  }
  assert.throws(() => validateTopLevelArguments('usage', ['usage', '--json', '--extra']), CommandUsageError)
  assert.throws(() => validateTopLevelArguments('release-readiness', ['release-readiness', '--json', '--json']), CommandUsageError)
  assert.throws(() => validateTopLevelArguments('release-readiness', ['release-readiness', '--text']), CommandUsageError)
  assert.throws(() => validateTopLevelArguments('unknown', ['unknown']), CommandUsageError)
  assert.doesNotThrow(() => validateTopLevelArguments('usage', ['usage', '--json']))
  assert.doesNotThrow(() => validateTopLevelArguments('release-readiness', ['release-readiness', '--json']))
  assert.doesNotThrow(() => validateTopLevelArguments('release-readiness', ['release-readiness']))
  assert.doesNotThrow(() => validateTopLevelArguments('login', ['login', '--tier', 'lite']))
})

test('mutating worker controls require explicit bounded subcommands', () => {
  assert.deepEqual(parseInteractiveCommand('/agents'), { kind: 'command', name: 'agents' })
  assert.deepEqual(parseInteractiveCommand('/agents start repair the failing test'), { kind: 'command', name: 'agents', argument: 'start repair the failing test' })
  assert.deepEqual(parseInteractiveCommand('/agents review worker-1'), { kind: 'command', name: 'agents', argument: 'review worker-1' })
  assert.throws(() => parseInteractiveCommand('/agents apply'), CommandUsageError)
  assert.throws(() => parseInteractiveCommand('/agents run arbitrary command'), CommandUsageError)
})

test('usage rendering preserves integer micro-units and identifies estimates', () => {
  assert.equal(formatUsage({ tier_label:'Swico Lite', wallet:{ available_micros:4959800, reserved_micros:0, token_estimate:{ range_min_tokens:25000, range_max_tokens:180000 } } }), 'Swico Chat usage (Swico Lite)\nAvailable Chat credit: 4,959,800 micros\nReserved Chat credit: 0 micros\nAllowance/eligibility: not shown by the usage endpoint\nEstimated token range: 25,000–180,000 tokens (estimate, not exact provider-token balance)')
  const zero = formatUsage({ tier:'lite', wallet:{ available_micros:0, reserved_micros:0 } })
  assert.match(zero, /Available Chat credit: 0 micros/)
  assert.match(zero, /Allowance\/eligibility: not shown by the usage endpoint/)
  assert.doesNotMatch(zero, /unavailable or exhausted|Entitlement:/)
  assert.match(formatUsage({ tier:'lite', wallet:{ available_micros:'1200000', reserved_micros:'0', billing_exempt:true } }), /Allowance\/eligibility: exempt account/)
  assert.match(formatUsage({ tier:'lite', wallet:{ reserved_micros:0 } }), /Available Chat credit: unavailable/)
  assert.match(formatUsage({ tier:'lite', wallet:{ available_micros:0, token_estimate:{ availability:'unavailable' } } }), /Token estimate: unavailable \(pricing estimate\)/)
  assert.match(formatUsage({ tier:'lite', wallet:{ available_micros:0 } }), /Token estimate: not shown by the usage endpoint/)
})

test('public API error normalization understands OAuth and FastAPI envelopes without exposing HTML', () => {
  const oauth = errorDetails({ detail:{ error:'invalid_grant', error_description:'Refresh token is expired, reused, or revoked' } }, 400)
  assert.equal(oauth.code, 'invalid_grant')
  assert.equal(oauth.retryable, false)
  assert.equal(oauth.stage, 'authentication')
  assert.match(oauth.message, /terminal authorization is no longer valid/)
  const access = errorDetails({ detail:'CLI access token is expired or revoked' }, 401)
  assert.match(access.message, /swico login --tier lite/)
  assert.doesNotMatch(access.message, /lite\|standard\|pro/)
  assert.equal(errorDetails({ detail:'<html>secret provider body</html>' }, 502).message, 'Swico request failed.')
})
