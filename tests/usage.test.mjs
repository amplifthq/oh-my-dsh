import assert from 'node:assert/strict'
import test from 'node:test'
import { renderUsage, summarizeUsage } from '../dist/packages/usage/src/index.js'

test('sums authoritative assistant-message usage fields', () => {
  const session = {
    events: [
      {
        type: 'assistant/chunk',
        data: {
          turn: 1,
          step: 1,
          chunk: {
            type: 'usage',
            usage: {
              inputTokens: 100,
              outputTokens: 20,
            },
          },
        },
      },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 80,
            reasoningTokens: 5,
          },
        },
      },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 2,
          usage: {
            inputTokens: 50,
            outputTokens: 10,
            cacheWriteTokens: 30,
          },
        },
      },
      {
        type: 'assistant/chunk',
        data: {
          turn: 2,
          step: 1,
          chunk: {
            type: 'usage',
            usage: {
              inputTokens: 25,
              outputTokens: 5,
            },
          },
        },
      },
      { type: 'tool/result', data: {} },
    ],
  }
  const summary = summarizeUsage(session)
  assert.deepEqual(summary, {
    calls: 3,
    inputTokens: 175,
    outputTokens: 35,
    cacheReadTokens: 80,
    cacheWriteTokens: 30,
    reasoningTokens: 5,
  })
  assert.match(renderUsage(summary), /Estimated cost: unavailable/)
})
