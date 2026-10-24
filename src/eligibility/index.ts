export {
  AREAS,
  AREA_LABELS,
  JOB_AREAS,
  canonicalProfileAreas,
  classifyJobAreas,
  unknownProfileAreas,
  type Area,
  type JobArea,
} from './areas.js';
export { evaluateJob } from './evaluate.js';
export { segmentDescription, strengthOf, type Context, type Segment } from './segments.js';
export {
  VERDICTS,
  type Criterion,
  type CriterionId,
  type CriterionKind,
  type EligibilityJob,
  type EligibilityResult,
  type EvaluateOptions,
  type Outcome,
  type Verdict,
} from './types.js';
export {
  analyzeJobs,
  profileHash,
  type AnalysisReport,
  type AnalyzeOptions,
  type AnalyzedJob,
} from './analyze.js';
