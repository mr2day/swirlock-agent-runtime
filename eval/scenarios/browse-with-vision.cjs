'use strict';

// Exercises the browse tool end-to-end: the model loads a real
// JS-rendered page in Chromium, receives a screenshot + text + link
// list, and produces an answer that references both visual and
// textual elements. We use Anthropic Haiku — it's vision-capable
// and cheap to run for an eval.
//
// example.com is a stable, fast-loading reference page that
// guarantees the eval doesn't flake on third-party uptime issues.

module.exports = {
  name: 'browse tool loads a page in Chromium and delivers image+text to a vision model',
  preconditions: ({ envSet }) => [envSet('ANTHROPIC_API_KEY')],
  input: {
    systemPrompt:
      'You are a small, friendly robot. Use the `browse` tool when the user asks you to look at a webpage. After browsing, describe what you see including the page title and the main heading text.',
    messages: [
      {
        role: 'user',
        content: 'Open https://example.com and tell me the page title and the main heading text.',
      },
    ],
    backend: { backend: 'anthropic' },
    userTimezone: 'Europe/Bucharest',
    maxOutputTokens: 400,
    maxSteps: 4,
  },
  expect: {
    toolCallsInclude: 'browse',
    minToolCalls: 1,
    answerNotEmpty: true,
    answerContains: ['example'],
    stopReason: 'completed',
    noTurnError: true,
  },
};
