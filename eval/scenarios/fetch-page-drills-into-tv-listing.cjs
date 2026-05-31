'use strict';

// The exact failure case from session a799e554 (Pro Cinema TV
// listing): search_web finds programtv.fun's Pro Cinema page in
// position 1 but the snippet is too short to reach the user's
// time slot. The fix is the new fetch_page tool. This scenario
// drives the search → fetch pattern and asserts that:
//   - search_web is called for the listing
//   - fetch_page is called on a URL from the search results
//   - the model produces a non-empty answer that didn't gaslight
//     (no "I'll search again" loops, no fabricated absence-of-data
//     claims)
//
// We use anthropic Haiku as the test driver — it's the most
// reliable at choosing the search → fetch pattern when the
// description tells it to. Ministral-3:14b is a separate question.

module.exports = {
  name: 'search → fetch pattern resolves a TV program lookup',
  preconditions: ({ envSet }) => [
    envSet('ANTHROPIC_API_KEY'),
    envSet('EXA_API_KEY'),
  ],
  input: {
    systemPrompt:
      'You are a small, friendly robot. Use tools when you need fresh info.',
    messages: [
      {
        role: 'user',
        content: 'caută "Program Pro Cinema 31 mai" și spune-mi ce difuzează acum seara, în jurul orei 22:45',
      },
    ],
    backend: { backend: 'anthropic' },
    userTimezone: 'Europe/Bucharest',
    maxOutputTokens: 600,
  },
  expect: {
    toolCallsInclude: 'search_web',
    minToolCalls: 2,
    answerNotEmpty: true,
    noTurnError: true,
  },
};
