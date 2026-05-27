'use strict';

// Anthropic's Haiku 4.5 is expected to recognise that the Max Korzh
// concert is a recent event it can't know from training data, and
// dispatch search_web. If the prompt's "WHEN TO CALL THIS" guidance
// on the search_web tool description regresses, this fails.

module.exports = {
  name: 'anthropic Haiku calls search_web for recent-event prompt',
  preconditions: ({ envSet }) => [envSet('ANTHROPIC_API_KEY'), envSet('EXA_API_KEY')],
  input: {
    systemPrompt:
      'You are a small, friendly robot. Use tools when you need fresh info or you do not know the answer.',
    messages: [
      {
        role: 'user',
        content: 'ce parere ai despre concertul lui Max Korzh la Bucuresti?',
      },
    ],
    backend: { backend: 'anthropic' },
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
