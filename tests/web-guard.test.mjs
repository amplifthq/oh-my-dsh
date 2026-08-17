import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import {
  SafeFetchProvider,
  assessFetchCommand,
  commandWords,
  expandIpv6,
  extractUrls,
  guardedLookup,
  isForbiddenAddress,
  isPrivateHost,
  validateFetchUrl,
} from '../dist/packages/web-guard/src/index.js'
import { isRegistrableRoot } from '../dist/packages/workspace/src/index.js'

const LIMITS = {
  maxUrlLength: 2048,
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 10_000,
  maxRedirects: 5,
  userAgent: 'omd-test',
  allowPrivateNetwork: false,
}

test('forbidden IPv4 addresses cover loopback, private, link-local, CGNAT, and reserved space', () => {
  for (const address of [
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '192.0.0.1',
    '198.18.0.1',
  ]) {
    assert.equal(isForbiddenAddress(address), true, `${address} must be forbidden`)
  }
  for (const address of [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.32.0.1',
    '172.15.0.1',
    '100.128.0.1',
    '9.9.9.9',
    '223.255.255.255',
  ]) {
    assert.equal(isForbiddenAddress(address), false, `${address} must be allowed`)
  }
})

test('forbidden IPv6 addresses cover loopback, link-local, ULA, multicast, and embedded IPv4', () => {
  for (const address of [
    '::1',
    '::',
    'fe80::1',
    'fe80::1%en0',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
  ]) {
    assert.equal(isForbiddenAddress(address), true, `${address} must be forbidden`)
  }
  for (const address of [
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ]) {
    assert.equal(isForbiddenAddress(address), false, `${address} must be allowed`)
  }
})

test('expandIpv6 rejects malformed literals and accepts embedded dotted quads', () => {
  assert.equal(expandIpv6('not-an-ip'), undefined)
  assert.equal(expandIpv6('1:2:3:4:5:6:7:8:9'), undefined)
  assert.equal(expandIpv6('1::2::3'), undefined)
  assert.deepEqual(expandIpv6('::ffff:127.0.0.1'), [0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001])
  assert.deepEqual(expandIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1])
})

test('private hosts include local names, bracketed IPv6, and blocked literals', () => {
  for (const host of [
    'localhost',
    'foo.localhost',
    'printer.local',
    'api.internal',
    'db.lan',
    'nas.home.arpa',
    '[::1]',
    '127.0.0.1',
    '10.1.2.3',
  ]) {
    assert.equal(isPrivateHost(host), true, `${host} must be private`)
  }
  for (const host of [
    'example.com',
    'api.deepseek.com',
    'localhost.evil.com',
    'internal-docs.example.com',
  ]) {
    assert.equal(isPrivateHost(host), false, `${host} must be public`)
  }
})

test('validateFetchUrl blocks private destinations, credentials, and non-http schemes', () => {
  assert.throws(
    () => validateFetchUrl('http://127.0.0.1/', LIMITS),
    (error) => error.code === 'WEB_BLOCKED_URL',
  )
  assert.throws(
    () => validateFetchUrl('http://localhost:3000/', LIMITS),
    (error) => error.code === 'WEB_BLOCKED_URL',
  )
  assert.throws(
    () => validateFetchUrl('http://169.254.169.254/latest/meta-data/', LIMITS),
    (error) => error.code === 'WEB_BLOCKED_URL',
  )
  assert.throws(
    () => validateFetchUrl('http://[::1]:8080/', LIMITS),
    (error) => error.code === 'WEB_BLOCKED_URL',
  )
  assert.throws(
    () => validateFetchUrl('http://user:pass@example.com/', LIMITS),
    (error) => error.code === 'WEB_BLOCKED_URL',
  )
  assert.throws(
    () => validateFetchUrl('ftp://example.com/', LIMITS),
    (error) => error.code === 'WEB_INVALID_URL',
  )
  assert.throws(
    () => validateFetchUrl(`http://example.com/${'a'.repeat(3000)}`, LIMITS),
    (error) => error.code === 'WEB_INVALID_URL',
  )
  assert.equal(validateFetchUrl('https://example.com/page', LIMITS).hostname, 'example.com')
  const open = { ...LIMITS, allowPrivateNetwork: true }
  assert.equal(validateFetchUrl('http://127.0.0.1:8080/', open).hostname, '127.0.0.1')
})

test('guardedLookup rejects names resolving to forbidden addresses at connect time', async () => {
  const outcome = await new Promise((resolvePromise) => {
    guardedLookup('localhost', { family: 0 }, (error, address) => {
      resolvePromise({ error, address })
    })
  })
  assert.ok(outcome.error, 'localhost must be rejected by the connect-time guard')
  assert.equal(outcome.error.code, 'WEB_BLOCKED_URL')
})

test('provider blocks private URLs before any request by default', async () => {
  const provider = new SafeFetchProvider(LIMITS)
  try {
    await assert.rejects(
      provider.fetch({ url: 'http://127.0.0.1:1/' }),
      (error) => error.code === 'WEB_BLOCKED_URL',
    )
  } finally {
    provider.dispose()
  }
})

test('provider fetches, follows same-origin redirects, and blocks cross-origin redirects', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/start') {
      response.writeHead(302, { location: '/final' })
      response.end()
    } else if (request.url === '/final') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>arrived</body></html>')
    } else if (request.url === '/cross') {
      response.writeHead(302, { location: 'http://cross-origin.example.com/elsewhere' })
      response.end()
    } else if (request.url === '/binary') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(Buffer.from([0, 1, 2]))
    } else if (request.url === '/huge') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '9000000' })
      response.end('x')
    } else if (request.url === '/loop') {
      response.writeHead(302, { location: '/loop' })
      response.end()
    } else {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('plain text body')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const provider = new SafeFetchProvider({ ...LIMITS, allowPrivateNetwork: true, maxRedirects: 3 })
  try {
    const direct = await provider.fetch({ url: `${base}/` })
    assert.equal(direct.statusCode, 200)
    assert.deepEqual(direct.body, { kind: 'text', content: 'plain text body' })
    assert.equal(direct.truncated, false)

    const redirected = await provider.fetch({ url: `${base}/start` })
    assert.equal(redirected.url, `${base}/final`)
    assert.equal(redirected.body.kind, 'html')
    assert.match(redirected.body.content, /arrived/)

    await assert.rejects(
      provider.fetch({ url: `${base}/cross` }),
      (error) => error.code === 'WEB_REDIRECT_BLOCKED',
    )
    await assert.rejects(
      provider.fetch({ url: `${base}/binary` }),
      (error) => error.code === 'WEB_UNSUPPORTED_CONTENT_TYPE',
    )
    await assert.rejects(
      provider.fetch({ url: `${base}/huge` }),
      (error) => error.code === 'WEB_FETCH_TOO_LARGE',
    )
    await assert.rejects(
      provider.fetch({ url: `${base}/loop` }),
      (error) => error.code === 'WEB_REDIRECT_BLOCKED',
    )
  } finally {
    provider.dispose()
    server.close()
  }
})

test('provider truncates oversized decoded bodies and reports truncation', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('abcdefghij'.repeat(10))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const provider = new SafeFetchProvider({ ...LIMITS, allowPrivateNetwork: true, maxBodyChars: 25 })
  try {
    const result = await provider.fetch({ url: `http://127.0.0.1:${server.address().port}/` })
    assert.equal(result.body.content.length, 25)
    assert.equal(result.truncated, true)
  } finally {
    provider.dispose()
    server.close()
  }
})

test('command words track command position across connectors, wrappers, and paths', () => {
  assert.deepEqual(commandWords('curl https://example.com'), ['curl'])
  assert.deepEqual(commandWords('ls && curl -s https://example.com | jq .'), ['ls', 'curl', 'jq'])
  assert.deepEqual(commandWords('FOO=1 sudo /usr/bin/curl https://example.com'), ['curl'])
  assert.deepEqual(commandWords('echo "curl is a tool"'), ['echo'])
})

test('extractUrls finds http(s) URLs and ignores malformed candidates', () => {
  const urls = extractUrls('curl https://example.com/a http://192.168.0.1:8080/b ftp://skip')
  assert.deepEqual(
    urls.map((url) => url.toString()),
    ['https://example.com/a', 'http://192.168.0.1:8080/b'],
  )
})

test('fetch-command assessment flags public shell fetches and passes local ones', () => {
  const flagged = assessFetchCommand('curl -A "Mozilla/5.0" https://news.ycombinator.com/item?id=1')
  assert.equal(flagged.usesFetcher, true)
  assert.deepEqual(flagged.publicUrls, ['https://news.ycombinator.com/item?id=1'])

  const wget = assessFetchCommand('wget https://example.com/file.tar.gz')
  assert.equal(wget.publicUrls.length, 1)

  const local = assessFetchCommand('curl http://localhost:3000/api/health')
  assert.equal(local.usesFetcher, true)
  assert.deepEqual(local.publicUrls, [])

  const privateIp = assessFetchCommand(
    'curl http://127.0.0.1:8080/metrics && curl http://10.0.0.5/status',
  )
  assert.deepEqual(privateIp.publicUrls, [])

  const noFetcher = assessFetchCommand('git clone https://github.com/foo/bar.git')
  assert.equal(noFetcher.usesFetcher, false)
  assert.deepEqual(noFetcher.publicUrls, [])

  const chained = assessFetchCommand('cd /tmp; curl https://example.com/payload')
  assert.deepEqual(chained.publicUrls, ['https://example.com/payload'])
})

test('alternate IPv4 literal encodings normalize to blocked destinations', () => {
  // WHATWG URL parsing normalizes decimal, hex, octal, and shorthand IPv4
  // forms; every alias of a loopback or metadata address must stay blocked.
  for (const url of [
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f000001/', // hex 127.0.0.1
    'http://017700000001/', // octal 127.0.0.1
    'http://127.1/', // shorthand 127.0.0.1
    'http://0x7f.1/', // mixed hex/shorthand
    'http://2852039166/', // decimal 169.254.169.254
    'http://[::ffff:169.254.169.254]/', // IPv4-mapped metadata address
    'http://[0:0:0:0:0:ffff:a9fe:a9fe]/', // expanded mapped form
  ]) {
    assert.throws(
      () => validateFetchUrl(url, LIMITS),
      (error) => error.code === 'WEB_BLOCKED_URL',
      `${url} must be blocked`,
    )
  }
})

test('trailing-dot hostnames are classified private before any DNS resolution', () => {
  for (const host of ['localhost.', 'foo.localhost.', 'printer.local.', 'api.internal.']) {
    assert.equal(isPrivateHost(host), true, `${host} must be private`)
  }
  assert.equal(isPrivateHost('example.com.'), false)
  assert.throws(
    () => validateFetchUrl('http://localhost./', LIMITS),
    (error) => error.code === 'WEB_BLOCKED_URL',
  )
})

test('guardedLookup rejects rebinding and public/private mixed resolutions', async () => {
  // Rebinding: the same name resolves publicly once, then to loopback. Every
  // connection re-validates, so the rebound resolution is refused.
  let calls = 0
  const rebinding = (_hostname, _options, callback) => {
    calls += 1
    callback(
      null,
      calls === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }],
    )
  }
  const first = await new Promise((resolvePromise) => {
    guardedLookup(
      'rebind.example',
      { family: 0 },
      (error, address) => resolvePromise({ error, address }),
      rebinding,
    )
  })
  assert.equal(first.error, null)
  assert.equal(first.address, '93.184.216.34')
  const second = await new Promise((resolvePromise) => {
    guardedLookup(
      'rebind.example',
      { family: 0 },
      (error, address) => resolvePromise({ error, address }),
      rebinding,
    )
  })
  assert.equal(second.error?.code, 'WEB_BLOCKED_URL')

  // A public/private mix is rejected outright, not retried on the public one.
  const mixed = (_hostname, _options, callback) =>
    callback(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ])
  const outcome = await new Promise((resolvePromise) => {
    guardedLookup('mixed.example', { family: 0 }, (error) => resolvePromise(error), mixed)
  })
  assert.equal(outcome?.code, 'WEB_BLOCKED_URL')
})

test('provider rejects credentialed redirect hops and unsupported charsets', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/cred') {
      const port = server.address().port
      response.writeHead(302, { location: `http://user:pass@127.0.0.1:${port}/plain` })
      response.end()
    } else if (request.url === '/charset') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=klingon' })
      response.end('body')
    } else {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('plain')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const provider = new SafeFetchProvider({ ...LIMITS, allowPrivateNetwork: true })
  try {
    await assert.rejects(
      provider.fetch({ url: `${base}/cred` }),
      (error) => error.code === 'WEB_BLOCKED_URL',
    )
    await assert.rejects(
      provider.fetch({ url: `${base}/charset` }),
      (error) => error.code === 'WEB_UNSUPPORTED_CONTENT_TYPE',
    )
  } finally {
    provider.dispose()
    server.close()
  }
})

test('workspace registration skips homes and filesystem roots', () => {
  assert.equal(isRegistrableRoot('/Users/someone', '/Users/someone'), false)
  assert.equal(isRegistrableRoot('/', '/Users/someone'), false)
  assert.equal(isRegistrableRoot('/Users/someone/repos/project', '/Users/someone'), true)
})
