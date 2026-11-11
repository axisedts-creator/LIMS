// C14 TRD §4.11 — versioned instruction text. Changing it creates p2 (new file), never edit in place.
export const PROMPT_VERSION = 'p1';

export const PROMPT_INSTRUCTIONS =
  'Rephrase each item for readability in the given language. ' +
  'Keep every {placeholder} token exactly as written. ' +
  'Add no facts, numbers, names, medicines, products, links or advice. ' +
  'Return one text per itemRef.';
