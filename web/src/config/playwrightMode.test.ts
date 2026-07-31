import { resolvePlaywrightRuntime } from './playwrightMode'

test('deployed mode uses one worker and a real HTTPS origin', () => {
  expect(resolvePlaywrightRuntime({ PLAYWRIGHT_BASE_URL:'https://staging.example.test/' })).toEqual({
    mode:'staging', deployedBaseUrl:'https://staging.example.test', workers:1,
  })
  expect(resolvePlaywrightRuntime({
    PLAYWRIGHT_MODE:'production-triag',
    PLAYWRIGHT_BASE_URL:'https://production.example.test/',
  })).toEqual({
    mode:'production-triag',
    deployedBaseUrl:'https://production.example.test',
    workers:1,
  })
})

test('local mode retains default worker behaviour and no deployed server', () => {
  expect(resolvePlaywrightRuntime({})).toEqual({ mode:'local', deployedBaseUrl:undefined, workers:undefined })
})

test('deployed mode rejects unsafe base URLs', () => {
  expect(() => resolvePlaywrightRuntime({ PLAYWRIGHT_BASE_URL:'http://staging.example.test' })).toThrow('credential-free HTTPS origin')
  expect(() => resolvePlaywrightRuntime({ PLAYWRIGHT_BASE_URL:'https://user:secret@staging.example.test?q=1' })).toThrow('credential-free HTTPS origin')
  expect(() => resolvePlaywrightRuntime({ PLAYWRIGHT_BASE_URL:'https://staging.example.test/nested' })).toThrow('credential-free HTTPS origin')
})
