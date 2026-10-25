export {
  DEFAULT_ANSWERS_PATH,
  answersSchema,
  loadAnswers,
  type ConfirmedAnswer,
} from './answers.js';
export {
  ApplicantError,
  DEFAULT_APPLICANT_PATH,
  applicantSchema,
  loadApplicant,
  maskEmail,
  maskPhone,
  nameParts,
  parseApplicant,
  type Applicant,
} from './applicant.js';
export { chooseCv, type ChosenCv } from './cv.js';
export { classifyPage, findConfirmation, type PageVerdict } from './detect.js';
export { ExecutorError, assertSafeUrl, type BrowserSession, type PageDriver } from './driver.js';
export { EXTRACT_FORM_SCRIPT, SIGNALS_SCRIPT } from './extract.js';
export { displayValue, planForm, type PlanContext } from './plan.js';
export {
  PlaywrightPage,
  findBrowser,
  launchSession,
  type LaunchOptions,
} from './playwright-driver.js';
export {
  runExecutor,
  type ExecItemReport,
  type ExecMode,
  type ExecOptions,
  type ExecRunReport,
} from './run.js';
export type * from './types.js';
