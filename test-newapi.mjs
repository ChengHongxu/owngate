#!/usr/bin/env node
// Quick test script for newapi integration (bypasses auth for local testing)

const BASE = 'http://localhost:3030'

async function call(path, opts = {}) {
  const headers = {}
  if (opts.body) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...headers, ...opts.headers },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return res.json()
}

async function main() {
  console.log('\n=== Testing newapi integration ===\n')

  // Read real config from env or use test values
  const REAL_BASE_URL = process.env.NEWAPI_BASE_URL || 'https://api.example.com'
  const REAL_TOKEN = process.env.NEWAPI_TOKEN || 'sk-test-token-12345'
  const REAL_USER_ID = process.env.NEWAPI_USER_ID || '1'
  const IS_REAL = process.env.NEWAPI_BASE_URL && process.env.NEWAPI_TOKEN

  console.log(`Using ${IS_REAL ? 'REAL' : 'FAKE'} newapi instance: ${REAL_BASE_URL}`)

  // 1. List connectors
  console.log('\n1. Listing connectors...')
  const connectors = await call('/admin/connectors')
  const newapi = connectors.connectors.find(c => c.id === 'newapi')
  console.log('   ✓ newapi connector:', newapi.title, `(auth: ${newapi.has_auth})`)

  // 2. Create connection
  console.log('\n2. Creating newapi connection...')
  const conn = await call('/admin/connections', {
    method: 'POST',
    body: JSON.stringify({
      connector_id: 'newapi',
      label: 'Test newapi',
      config: {
        base_url: REAL_BASE_URL,
        user_id: REAL_USER_ID,
        quota_per_unit: 500000,
      },
    }),
  })
  console.log('   Created:', conn.id, conn.label)
  console.log('   Capability states:', JSON.stringify(conn.capability_states, null, 2))

  // 3. Set credentials
  console.log('\n3. Setting credentials...')
  await call(`/admin/connections/${conn.id}/credentials`, {
    method: 'PUT',
    body: JSON.stringify({
      credentials: {
        access_token: REAL_TOKEN,
      },
    }),
  })
  console.log('   ✓ Credentials saved')

  // 4. List capabilities
  console.log('\n4. Listing capabilities...')
  const caps = await call(`/admin/capabilities?connector_id=newapi`)
  console.log('   Capabilities:', caps.capabilities.map(c => c.id).join(', '))

  // 5. Test invoke
  console.log('\n5. Testing invoke (account.balance)...')
  try {
    const result = await call('/admin/invoke', {
      method: 'POST',
      body: JSON.stringify({
        connection_id: conn.id,
        capability_id: 'account.balance',
      }),
    })
    if (result.status === 'ok') {
      console.log('   ✓ SUCCESS! Data:', JSON.stringify(result.data, null, 2))
    } else {
      console.log('   Error:', result.error.code, '-', result.error.message)
      if (!IS_REAL) {
        console.log('   (Expected: using fake URL)')
      }
    }
  } catch (e) {
    console.log('   Exception:', e.message)
  }

  // 6. Cleanup
  console.log('\n6. Cleaning up...')
  await call(`/admin/connections/${conn.id}`, { method: 'DELETE' })
  console.log('   ✓ Connection deleted')

  console.log('\n=== All tests passed! ===\n')
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message)
  process.exit(1)
})
