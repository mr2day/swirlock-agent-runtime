'use strict';

// On the Romanian "Max Korzh" prompt, ministral-3:14b consistently
// emits `search_web[ARGS]{...}` as plain text without the
// `[TOOL_CALLS]` opener. The repairMistralToolCallText middleware
// (wired in BackendsService.resolve for this specific modelId)
// must catch the malformed call and dispatch it as a structured
// tool call. Failure here means the middleware regressed.

module.exports = {
  name: 'ministral-3:14b malformed tool-call is repaired by middleware',
  preconditions: ({ ollamaModel, envSet }) => [
    ollamaModel('ministral-3:14b'),
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
    backend: { backend: 'ollama-local', model: 'ministral-3:14b' },
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
