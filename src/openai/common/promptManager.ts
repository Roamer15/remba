import { ChatCompletionMessageParam } from 'openai/resources.js';

export async function PromptManager(
  model: string = 'gpt-4o-mini',
  messages: ChatCompletionMessageParam[],
  temperature: number,
) {
  await this.openai.chat.completions({
    model,
    messages,
    response_format: { format_type: 'json' },
    temperature,
  });
}
