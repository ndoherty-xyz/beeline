import type { ModelWeights } from "beeline";

export const CLICKS_PER_UPDATE = 100;
export const PERSONAL_MODEL_VERSION = 2;

export type PersonalModel = { weights: ModelWeights; clickCount: number; learnedUntil: number; version: number };

/**
 * Function to read weights trained with the current update rule.
 * @param model The personal model from extension storage.
 * @returns The current personal model, or undefined during migration or cold start.
 */
export function currentPersonalModel(model: PersonalModel | undefined): PersonalModel | undefined {
  return model?.version === PERSONAL_MODEL_VERSION ? model : undefined;
}
