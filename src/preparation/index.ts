export {
  GENERATOR_VERSION,
  cleanInline,
  generateDraft,
  type Fact,
  type GeneratedDraft,
} from './message.js';
export {
  answerQuestion,
  detectRequirements,
  type RequirementKind,
  type RequirementSpec,
} from './requirements.js';
export {
  PreparationError,
  READINESS_LABELS,
  addQuestion,
  answerRequirement,
  assertDraftSafe,
  computeReadiness,
  getDraftRecord,
  getPreparation,
  listCandidates,
  markReviewed,
  prepareApplication,
  type Candidate,
  type PrepareOptions,
  type PrepareResult,
  type PreparationView,
  type Readiness,
  type RequirementView,
} from './service.js';
