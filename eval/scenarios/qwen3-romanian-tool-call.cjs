'use strict';

// qwen3:14b is the default ollama-local model precisely because it
// emits structured tool calls reliably on Romanian prompts (where
// ministral-3:14b leaks the call as text). This scenario locks that
// property in.

module.exports = {
  name: 'qwen3:14b emits structured tool call on Romanian prompt',
  preconditions: ({ ollamaModel, envSet }) => [
    ollamaModel('qwen3:14b'),
    envSet('EXA_API_KEY'),
  ],
  input: {
    systemPrompt:
      'You are a small, friendly robot. Use tools when you need fresh info or you do not know the answer.',
    messages: [
      {
        role: 'user',
        content: 'ce parere ai despre concertul lui Max Korzh la Bucuresti?',
      },
    ],
    backend: { backend: 'ollama-local', model: 'qwen3:14b' },
    userTimezone: 'Europe/Bucharest',
    maxOutputTokens: 500,
  },
  expect: {
    toolCallsInclude: 'search_web',
    minToolCalls: 1,
    answerNotEmpty: true,
    noMalformedToolCallText: true,
    stopReason: 'completed',
    noTurnError: true,
  },
};
