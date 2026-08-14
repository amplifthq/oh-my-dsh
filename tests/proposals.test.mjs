import assert from 'node:assert/strict'
import test from 'node:test'
import {
  proposalApprovalReason,
  ProposalStore,
  requiresProposalApproval,
} from '../dist/packages/proposals/src/index.js'

function input(commit = async () => ({ summary: 'applied' })) {
  return {
    kind: 'mcp-activate',
    title: 'Activate docs',
    summary: 'Start the docs MCP server.',
    effects: [{ type: 'mcp-server', target: 'docs', summary: 'Start one server.' }],
    commit,
  }
}

test('proposal ids are monotonic and proposals are isolated by agent', () => {
  const store = new ProposalStore()
  const firstAgent = {}
  const secondAgent = {}

  const first = store.create(firstAgent, input())
  const second = store.create(firstAgent, input())
  store.create(secondAgent, input())

  assert.equal(first.id, 'proposal-1')
  assert.equal(second.id, 'proposal-2')
  assert.deepEqual(store.list(firstAgent).map((proposal) => proposal.id), ['proposal-1', 'proposal-2'])
  assert.equal(store.list(secondAgent).length, 1)
})

test('successful apply removes the proposal', async () => {
  const store = new ProposalStore()
  const agent = {}
  const proposal = store.create(agent, input())

  const result = await store.apply(agent, proposal.id, {})

  assert.deepEqual(result, { summary: 'applied' })
  assert.equal(store.show(agent, proposal.id), undefined)
})

test('failed apply remains visible but cannot be retried', async () => {
  const store = new ProposalStore()
  const agent = {}
  const proposal = store.create(agent, input(async () => {
    throw new Error('stale')
  }))

  await assert.rejects(store.apply(agent, proposal.id, {}), /stale/)
  assert.equal(store.show(agent, proposal.id)?.status, 'failed')
  await assert.rejects(store.apply(agent, proposal.id, {}), /not pending/)
})

test('discard removes a pending proposal', () => {
  const store = new ProposalStore()
  const agent = {}
  const proposal = store.create(agent, input())

  assert.equal(store.discard(agent, proposal.id), true)
  assert.equal(store.show(agent, proposal.id), undefined)
  assert.equal(store.discard(agent, proposal.id), false)
})

test('only applying a proposal requires explicit approval', () => {
  assert.equal(requiresProposalApproval('proposal_control', { action: 'apply' }), true)
  assert.equal(requiresProposalApproval('proposal_control', { action: 'show' }), false)
  assert.equal(requiresProposalApproval('other_tool', { action: 'apply' }), false)
  assert.equal(requiresProposalApproval('proposal_control', null), false)
})

test('approval reason repeats the exact reviewed effects', () => {
  const reason = proposalApprovalReason({
    id: 'proposal-9',
    kind: 'mcp-activate',
    title: 'Activate docs',
    summary: 'Start the reviewed server.',
    effects: [{
      type: 'mcp-server-activation',
      target: 'docs',
      summary: 'Start /usr/local/bin/node.',
      details: {
        endpoint: '/usr/local/bin/node',
        argumentPreview: ['server.js', '--token', '[redacted]'],
        cwd: '/workspace',
        configPath: '/workspace/.mcp.json',
      },
    }],
    status: 'pending',
  })

  assert.match(reason, /proposal-9/)
  assert.match(reason, /\/usr\/local\/bin\/node/)
  assert.match(reason, /server\.js/)
  assert.match(reason, /\[redacted\]/)
  assert.match(reason, /\/workspace\/\.mcp\.json/)
})

test('discard refuses to hide an applying proposal', async () => {
  const store = new ProposalStore()
  const agent = {}
  let finish
  const proposal = store.create(agent, input(() => new Promise((resolve) => {
    finish = resolve
  })))
  const applying = store.apply(agent, proposal.id, {})
  await Promise.resolve()

  assert.throws(() => store.discard(agent, proposal.id), /cannot discard an applying proposal/)
  finish({ summary: 'done' })
  await applying
})

test('aborting a producer lifecycle removes its pending proposals', () => {
  const store = new ProposalStore()
  const agent = {}
  const lifecycle = new AbortController()
  const proposal = store.create(agent, {
    ...input(),
    signal: lifecycle.signal,
  })

  lifecycle.abort()

  assert.equal(store.show(agent, proposal.id), undefined)
})
