import type { ModelWeights } from "beeline";

export const CLICKS_PER_UPDATE = 100;

export type PersonalModel = { weights: ModelWeights; clickCount: number; learnedUntil: number };
