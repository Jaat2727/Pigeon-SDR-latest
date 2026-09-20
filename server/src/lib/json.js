/**
 * Loose JSON parsing for model output. A model asked for "JSON only" still
 * occasionally wraps it in markdown fences or a sentence of preamble; this
 * tries the honest parse first and only reaches for recovery after that
 * fails.
 */

/** Strips markdown fences and parses the first JSON object or array it finds. */
export function parseLooseJson(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'object') return input;
  if (typeof input !== 'string') return null;

  const text = input.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    /* keep trying */
  }

  const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* keep trying */
    }
  }

  // First balanced-looking object or array in the text.
  const firstBrace = text.search(/[{[]/);
  if (firstBrace !== -1) {
    const opener = text[firstBrace];
    const closer = opener === '{' ? '}' : ']';
    const lastClose = text.lastIndexOf(closer);
    if (lastClose > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastClose + 1));
      } catch {
        /* give up */
      }
    }
  }

  return null;
}
