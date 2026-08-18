import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'forged-toolsmith'
export const provide = []
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'forged_echo',
      description: 'Echo a message back, proving a forged tool is invocable.',
      parameters: {
        message: { type: 'string', required: true, description: 'Message to echo.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => args.message,
    }),
  )
}
