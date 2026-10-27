// Login-free check of API evidence recording. A stub server in this file plays a
// tiny policies + commissions API, and its responses deliberately carry an
// agent email, a password and a JWT so the cleaning can be verified:
//   node bin/ft-e2e-run.mjs run --ticket _api-smoke --api --skip-preflight
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from '../../fixtures'

let server: http.Server
let base = ''

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('trace-id', 'stub-trace-0001')
      if (req.method === 'GET' && req.url?.startsWith('/api/policies')) {
        res.end(JSON.stringify({ data: [{ str_id: 'pol_E2E_1', policy_id: 'E2E-0001', carrier: 'Stub Life', premium: 1200 }], count: 1 }))
      } else if (req.method === 'POST' && req.url === '/api/commissions') {
        const sent = JSON.parse(body || '{}')
        res.statusCode = 201
        res.end(JSON.stringify({ str_id: 'com_E2E_1', agent: { email: sent.agent?.email, phone: sent.agent?.phone }, password: 'hunter2', token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdHViLXVzZXIifQ.c2lnbmF0dXJlLXN0dWI' }))
      } else {
        res.statusCode = 404
        res.end(JSON.stringify({ message: 'Not Found' }))
      }
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})

test.afterAll(async () => { await new Promise(r => server.close(r)) })

test('api smoke: a list, a create and a 404 are recorded and cleaned', async ({ apiFor }) => {
  const api = await apiFor(base)
  const list = await api.get('api/policies?limit=5&q=E2E')
  expect(list.status()).toBe(200)
  expect((await list.json()).data[0].policy_id).toBe('E2E-0001')

  const created = await api.post('api/commissions', { data: { agent: { email: 'agent@example-agency.com', phone: '+1 415 555 0101' }, bank: { cardNumber: '4242424242424242', cvc: '123' } } })
  expect(created.status()).toBe(201)

  const missing = await api.get('api/no-such-endpoint')
  expect(missing.status()).toBe(404)
})
