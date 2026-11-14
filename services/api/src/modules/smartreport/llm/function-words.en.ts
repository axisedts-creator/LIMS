// C14 TRD §4.12 L7 — bundled allowlist for the novelty check. Function words only: no health, medicine, product or number words.
export const FUNCTION_WORDS_EN: ReadonlySet<string> = new Set([
  'about', 'above', 'after', 'again', 'also', 'always', 'among', 'and', 'any', 'are', 'because', 'been', 'before',
  'being', 'below', 'between', 'both', 'but', 'can', 'could', 'did', 'does', 'during', 'each', 'either', 'for',
  'from', 'further', 'had', 'has', 'have', 'her', 'here', 'him', 'his', 'how', 'into', 'its', 'may', 'might',
  'more', 'most', 'must', 'neither', 'nor', 'not', 'off', 'once', 'only', 'other', 'our', 'out', 'over', 'please',
  'shall', 'she', 'should', 'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'too', 'under', 'until', 'upon', 'was', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'within', 'without', 'would', 'you', 'your',
]);
