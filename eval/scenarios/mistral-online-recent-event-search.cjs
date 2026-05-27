'use strict';

// Mistral La Plateforme's Ministral 14B is the production default
// backend (AGENT_DEFAULT_BACKEND=mistral-online). Same expectation
// as the Anthropic scenario: a recent-event Romanian prompt must
// route to search_web reliably.

module.exports = {
  name: 'mistral-online Ministral 14B calls search_web for recent-event prompt',
  preconditions: ({ envSet }) => [envSet('MISTRAL_API_KEY'), envSet('EXA_API_KEY')],
  input: {
    systemPrompt:
      'You are a small, friendly robot. Use tools when you need fresh info or you do not know the answer.',
    messages: [
      {
        role: 'user',
        content: 'ce parere ai despre concertul lui Max Korzh la Bucuresti?',
      },
    ],
    backend: { backend: 'mistral-online' },
    userTimezone: 'Europe/Bucharest',
    maxOutputTokens: 500,
  },
  expect: {
    toolCallsInclude: 'search_web',
    minToolCalls: 1,
    answerNotEmpty: true,
    stopReason: 'completed',
    noTurnError: true,
  },
};
