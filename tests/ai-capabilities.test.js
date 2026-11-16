const {
  buildAiCapabilitiesPrompt,
  buildAiQuickReply,
  classifyAiIntent,
} = require('../services/ai-capabilities');

describe('AI capability prompt', () => {
  test('instructs the AI to describe its actual capabilities rather than greet generically', () => {
    const prompt = buildAiCapabilitiesPrompt({ webSearchAvailable: true });

    expect(prompt).toContain('OHNE ALLGEMEINE BEGRÜSSUNG');
    expect(prompt).toContain('Fragen beantworten und Sachverhalte erklären');
    expect(prompt).toContain('Wetterdaten');
    expect(prompt).toContain('OpenRouter/Exa');
    expect(prompt).toContain('/hilfe');
    expect(prompt).toContain('Discord-Befehle nicht selbst ausführen');
  });

  test('does not claim web search when it is unavailable', () => {
    const prompt = buildAiCapabilitiesPrompt({ webSearchAvailable: false });

    expect(prompt).toContain('keine Websuche zur Verfügung');
    expect(prompt).not.toContain('OpenRouter/Exa');
  });

  test('matches the screenshot capability question despite greeting and bot name', () => {
    const question = 'hallo bob ---- kannst du mir sagen was du alles kannst';

    expect(classifyAiIntent(question, 'Bob')).toBe('capabilities');
    expect(buildAiQuickReply({
      question,
      personaName: 'Bob',
      webSearchAvailable: true,
    })).toContain('Webquellen nutzen');
  });

  test('answers identity and a general help request with distinct replies', () => {
    expect(buildAiQuickReply({
      question: 'Hey Bockis, wer bist du?',
      personaName: 'Bockis',
      webSearchAvailable: false,
    })).toContain('Ich bin Bockis');
    expect(buildAiQuickReply({
      question: 'Kannst du mir helfen?',
      personaName: 'Bockis',
      webSearchAvailable: false,
    })).toContain('Erzähl mir kurz');
  });

  test('passes specific help requests through to the AI', () => {
    expect(classifyAiIntent('Kannst du mir bei meinem Update helfen?', 'Bob')).toBeNull();
    expect(buildAiQuickReply({
      question: 'Kannst du mir bei meinem Update helfen?',
      personaName: 'Bob',
      webSearchAvailable: false,
    })).toBeNull();
  });
});
