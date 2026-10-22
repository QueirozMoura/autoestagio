export {
  DEFAULT_SOURCES_PATH,
  SOURCE_KINDS,
  loadSourcesConfig,
  parseSourcesConfig,
  type SourceKind,
  type SourceTarget,
  type SourcesConfig,
} from './config.js';
export {
  SourceConfigError,
  SourceRegistry,
  createHttpClient,
  createSourceContext,
  type SourceFactory,
} from './registry.js';
export {
  SourceError,
  rawJobSchema,
  sourceKey,
  toSourceError,
  type JobSource,
  type RawJob,
  type SourceContext,
  type SourceErrorCategory,
  type SourceLimits,
} from './types.js';
