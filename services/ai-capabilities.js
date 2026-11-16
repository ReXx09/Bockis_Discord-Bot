function normalizeQuestion(question, personaName) {
  let normalized = String(question || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLocaleLowerCase('de-DE')
    .replace(/<@!?\d+>/g, ' ')
    .replace(/[^\w]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  normalized = normalized.replace(/^(?:hallo|hey|hi|moin|servus|guten tag)\s+/, '');
  const normalizedName = String(personaName || '').toLocaleLowerCase('de-DE').replace(/[^\w]+/g, ' ').trim();
  if (normalizedName) {
    normalized = normalized.replace(new RegExp(`^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`), '');
  }
  return normalized.replace(/^(?:bitte\s+)+|(?:\s+bitte)+$/g, '').trim();
}

function classifyAiIntent(question, personaName) {
  const normalized = normalizeQuestion(question, personaName);
  const capabilityQuestion = /^(?:(?:kannst du mir sagen|sag mir|erzaehl mir|nenne mir|nenn mir) )?(?:was kannst du(?: alles)?|was kannst du machen|was sind deine (?:faehigkeiten|funktionen)|welche (?:faehigkeiten|funktionen) hast du|wobei kannst du helfen)(?: bitte)?$/
    .test(normalized)
    || /^(?:kannst du mir sagen|sag mir|erzaehl mir) (?:was du(?: alles)? kannst|welche (?:faehigkeiten|funktionen) du hast)$/
      .test(normalized);
  if (capabilityQuestion) return 'capabilities';

  if (/^(?:(?:kannst du mir sagen|sag mir|erzaehl mir) )?(?:wer bist du|wie heisst du|was bist du|wie ist dein name|stell dich vor)$/.test(normalized)) {
    return 'identity';
  }

  if (/^(?:kannst du mir helfen|kannst du helfen|hilfst du mir|ich brauche hilfe|ich benoetige hilfe)$/.test(normalized)) {
    return 'help';
  }

  return null;
}

function buildAiQuickReply({ question, personaName, webSearchAvailable }) {
  switch (classifyAiIntent(question, personaName)) {
    case 'identity':
      return `Ich bin ${personaName || 'Bockis'}, der KI-Chat-Assistent dieses Discord-Servers. Mit \`/hilfe\` findest du die verfügbaren Bot-Befehle.`;
    case 'capabilities':
      return [
        'Ich kann Fragen beantworten, Themen erklären und dir beim Schreiben oder Brainstormen helfen.',
        'Wetterfragen kann ich mit aktuellen Wetterdaten beantworten.',
        webSearchAvailable
          ? 'Bei aktuellen oder ausdrücklich recherchierten Fragen kann ich außerdem Webquellen nutzen.'
          : 'Eine Websuche steht mir in der aktuellen Konfiguration nicht zur Verfügung.',
        'Die verfügbaren Bot-Befehle findest du unter `/hilfe`; ich führe sie nicht selbst aus.',
      ].join(' ');
    case 'help':
      return 'Klar! Erzähl mir kurz, wobei du Unterstützung brauchst. Ich kann Fragen beantworten, etwas erklären oder dir beim Schreiben und Ideenfinden helfen.';
    default:
      return null;
  }
}

function buildAiCapabilitiesPrompt({ webSearchAvailable }) {
  const webSearchDescription = webSearchAvailable
    ? 'Bei aktuellen oder ausdrücklich recherchierten Fragen kannst du eine Websuche über OpenRouter/Exa nutzen. Sie wird nicht bei jeder Frage ausgeführt.'
    : 'In der aktuellen Konfiguration steht dir keine Websuche zur Verfügung.';

  return [
    'BEANTWORTE FRAGEN NACH DEINEN FÄHIGKEITEN KONKRET UND OHNE ALLGEMEINE BEGRÜSSUNG:',
    '- Du kannst im Chat Fragen beantworten und Sachverhalte erklären.',
    '- Wetterfragen kannst du anhand aktueller Wetterdaten beantworten, wenn diese im Gesprächskontext bereitgestellt werden.',
    `- ${webSearchDescription}`,
    '- Mit /hilfe können Nutzer alle aktiven Bot-Befehle sehen.',
    '- Du kannst Discord-Befehle nicht selbst ausführen; Nutzer müssen den passenden Befehl selbst aufrufen.',
    'Erfinde keine Funktionen und behaupte nicht, du könntest zuhören, aufheitern oder Aktionen ausführen, sofern das nicht ausdrücklich durch eine aktive Funktion abgedeckt ist.',
  ].join('\n');
}

module.exports = {
  buildAiCapabilitiesPrompt,
  buildAiQuickReply,
  classifyAiIntent,
};
