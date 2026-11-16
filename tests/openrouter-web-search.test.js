const {
  appendWebCitations,
  buildOpenRouterWebSearchPlugin,
  getOpenRouterWebSearchPlugin,
  isOpenRouterBaseUrl,
  shouldUseWebSearch,
} = require('../services/openrouter-web-search');

describe('OpenRouter web search', () => {
  test('only identifies OpenRouter API hosts', () => {
    expect(isOpenRouterBaseUrl('https://openrouter.ai/api/v1')).toBe(true);
    expect(isOpenRouterBaseUrl('https://api.openai.com/v1')).toBe(false);
    expect(isOpenRouterBaseUrl('not a URL')).toBe(false);
  });

  test('requests search for current or explicitly researched questions', () => {
    expect(shouldUseWebSearch('Wie ist die aktuelle Formel-1-Weltrangliste?')).toBe(true);
    expect(shouldUseWebSearch('Recherchiere bitte die heutigen Ergebnisse.')).toBe(true);
    expect(shouldUseWebSearch('Was ist die Hauptstadt von Frankreich?')).toBe(false);
  });

  test('keeps the selected free model and limits OpenRouter search results', () => {
    expect(buildOpenRouterWebSearchPlugin()).toMatchObject({
      id: 'web',
      engine: 'exa',
      max_results: 3,
    });
  });

  test('only adds paid search for enabled OpenRouter current-information requests', () => {
    const request = {
      baseUrl: 'https://openrouter.ai/api/v1',
      enabled: true,
      userContent: 'Aktuelle Formel-1-Weltrangliste',
    };
    expect(getOpenRouterWebSearchPlugin(request)).toEqual(buildOpenRouterWebSearchPlugin());
    expect(getOpenRouterWebSearchPlugin({ ...request, enabled: false })).toBeNull();
    expect(getOpenRouterWebSearchPlugin({ ...request, baseUrl: 'https://api.openai.com/v1' })).toBeNull();
    expect(getOpenRouterWebSearchPlugin({ ...request, userContent: 'Was ist die Hauptstadt?' })).toBeNull();
    expect(getOpenRouterWebSearchPlugin({ ...request, weatherContext: 'Temperatur: 12 °C' })).toBeNull();
  });

  test('adds safe, unique source links from OpenRouter annotations', () => {
    expect(appendWebCitations('Aktueller Stand.', [
      { type: 'url_citation', url_citation: { url: 'https://example.com/rank' } },
      { type: 'url_citation', url_citation: { url: 'https://example.com/rank' } },
      { type: 'url_citation', url_citation: { url: 'javascript:alert(1)' } },
    ])).toBe('Aktueller Stand.\n\nQuellen: [example.com](https://example.com/rank)');
  });

  test('does not duplicate sources already cited in the answer', () => {
    expect(appendWebCitations('Quelle: https://example.com/rank', [
      { type: 'url_citation', url_citation: { url: 'https://example.com/rank' } },
    ])).toBe('Quelle: https://example.com/rank');
  });
});
