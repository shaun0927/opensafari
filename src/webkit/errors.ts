/**
 * Shared error classes for the webkit package.
 *
 * Extracted here to break the circular dependency between client.ts and
 * evaluate.ts: evaluate.ts threw EvaluationError but had to import it from
 * client.ts, which in turn imported evaluateValue from evaluate.ts.
 */

export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationError';
  }
}
