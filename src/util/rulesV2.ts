import { validateRegex } from '~/util/validate';
import { canUseSimpleCategoryUI, expressionUsesLegacyWindow } from '~/util/rulesV2Migration';

export const RULES_SCHEMA_VERSION = 2 as const;
export const SOURCE_DEFAULTS_VERSION = 4;
export const MAX_EXPRESSION_DEPTH = 32;
export const MAX_EXPRESSION_NODES = 4096;
export const MAX_REGEX_LENGTH = 4096;
export const MAX_CATEGORY_RULES = 1000;
export const MAX_RULE_SOURCES = 128;
export const MIN_RULE_RANK = -1_000_000;
export const MAX_RULE_RANK = 1_000_000;
export const BUILTIN_WINDOW_SOURCE_ID = 'builtin_window';
export const BUILTIN_BROWSER_SOURCE_ID = 'browser';
export const BUILTIN_STOPWATCH_SOURCE_ID = 'stopwatch';
export type BuiltinSource = 'window' | 'browser' | 'stopwatch';
export type SourceIntervalPolicy = 'exact' | 'heartbeat';

export type RuleValueMode = 'string' | 'scalar';

export interface NoneExpressionV2 {
  type: 'none';
}

export interface RegexExpressionV2 {
  type: 'regex';
  regex: string;
  source?: string;
  host?: string;
  field?: string;
  fields?: string[];
  select_keys?: string[];
  ignore_case?: boolean;
  negate?: boolean;
  value_mode?: RuleValueMode;
  weight?: number;
}

export interface GroupExpressionV2 {
  type: 'all' | 'any';
  rules: RuleExpressionV2[];
}

export type RuleExpressionV2 = NoneExpressionV2 | RegexExpressionV2 | GroupExpressionV2;

export function effectiveRuleSelector(
  expression: Pick<RegexExpressionV2, 'fields' | 'field' | 'select_keys'>
): string[] {
  if (expression.fields !== undefined) return [...expression.fields];
  if (expression.field !== undefined) return [expression.field];
  return [...(expression.select_keys ?? [])];
}

export interface CategoryRuleV2 {
  [key: string]: unknown;
  id: string;
  name: string[];
  rule: RuleExpressionV2;
  simple_ui?: boolean;
  priority?: number;
  requires?: string[];
  data?: Record<string, unknown>;
}

export interface CategorySetV2 {
  schema_version: typeof RULES_SCHEMA_VERSION;
  id: string;
  /** Higher values win after rule/category/depth ranking ties. */
  priority?: number;
  categories: CategoryRuleV2[];
}

export interface SourceDefinitionV2 {
  id: string;
  label: string;
  bucket_ids: string[];
  builtin?: BuiltinSource;
  scope?: 'host' | 'global';
  bucket_hosts?: Record<string, string>;
  fields: string[];
  field_types?: Record<string, 'string' | 'scalar'>;
  interval_policy?: SourceIntervalPolicy;
  auto_generated?: boolean;
  creates_activity?: boolean;
  keeps_active?: boolean;
  /** @deprecated Migrated to creates_activity when settings are loaded. */
  activity_mode?: 'replace' | 'fill-gaps';
  /** @deprecated Migrated to creates_activity when settings are loaded. */
  role?: 'activity' | 'background' | 'context' | 'active-mask';
  /** @deprecated Migrated to creates_activity when settings are loaded. */
  merge_mode?: 'replace' | 'enrich';
  /** @deprecated Source precedence is not part of the abstract activity model. */
  priority?: number;
  /** @deprecated Activity data remains namespaced by source. */
  legacy_fields?: Record<string, string>;
  /** @deprecated Activity data remains namespaced by source. */
  canonical_fields?: Record<string, string>;
  host?: string;
}

export interface ActiveTimeLegacyV2 {
  type: 'legacy';
  use_afk: boolean;
  include_audible: boolean;
  always_active_pattern: string;
}

export interface ActiveTimeExpressionV2 {
  type: 'expression';
  rule: RuleExpressionV2;
}

export interface ActivityProfileV2 {
  schema_version: typeof RULES_SCHEMA_VERSION;
  source_defaults_version?: number;
  id: string;
  category_set_ids: string[];
  sources: SourceDefinitionV2[];
  app_title_source_id?: string;
  browser_focus_source_id?: string;
  active_time: ActiveTimeLegacyV2 | ActiveTimeExpressionV2;
}

export interface ProfileSourcesDraftV2 {
  sources: SourceDefinitionV2[];
  app_title_source_id: string | null;
  browser_focus_source_id: string | null;
}

export function createProfileSourcesDraft(
  profile: ActivityProfileV2 | undefined
): ProfileSourcesDraftV2 {
  return {
    sources: JSON.parse(JSON.stringify(profile?.sources ?? [])),
    app_title_source_id: profile?.app_title_source_id ?? null,
    browser_focus_source_id: profile?.browser_focus_source_id ?? null,
  };
}

export function profileSourcesDraftIsDirty(
  draft: ProfileSourcesDraftV2,
  profile: ActivityProfileV2 | undefined
): boolean {
  return JSON.stringify(draft) !== JSON.stringify(createProfileSourcesDraft(profile));
}

export function profileSourcesDraftForSave(
  draft: ProfileSourcesDraftV2,
  profile: ActivityProfileV2 | undefined
): SourceDefinitionV2[] | undefined {
  return profileSourcesDraftIsDirty(draft, profile) ? draft.sources : undefined;
}

export interface CompiledProfileQueryOptions {
  category_specs: CategoryRuleV2[];
  context_sources: Array<{
    source_id: string;
    bucket_ids: string[];
    scope?: 'host' | 'global';
    bucket_hosts?: Record<string, string>;
    fields: string[];
    interval_policy?: SourceIntervalPolicy;
    conflict: 'base_wins';
    host?: string;
  }>;
  active_time_rule?: RuleExpressionV2;
  active_time_sources?: Array<{
    source_id: string;
    bucket_ids: string[];
    scope?: 'host' | 'global';
    bucket_hosts?: Record<string, string>;
    interval_policy?: SourceIntervalPolicy;
    host?: string;
  }>;
  activity_coverage_sources: Array<{
    source_id: string;
    bucket_ids: string[];
    scope?: 'host' | 'global';
    bucket_hosts?: Record<string, string>;
    fields: string[];
    interval_policy?: SourceIntervalPolicy;
    host?: string;
  }>;
  /** @deprecated Compatibility input for older query builders. */
  activity_sources: Array<{
    source_id: string;
    bucket_ids: string[];
    scope?: 'host' | 'global';
    bucket_hosts?: Record<string, string>;
    field_mappings: Record<string, string>;
    host?: string;
  }>;
  /** @deprecated Compatibility input for older query builders. */
  background_sources: Array<{
    source_id: string;
    bucket_ids: string[];
    scope?: 'host' | 'global';
    bucket_hosts?: Record<string, string>;
    field_mappings: Record<string, string>;
    host?: string;
  }>;
  capabilities: string[];
  legacy_window_mode: 'activity' | 'context' | 'none';
  legacy_window_fields: string[];
}

// ---------------------------------------------------------------------------
// v2-pure compiled representation (no legacy window privilege).
//
// Unlike CompiledProfileQueryOptions (used only by the explicit Android/old-target
// path), this representation never carries legacy_window_mode.
// The configured default window source is compiled into an ordinary namespaced
// coverage/context source (identified by builtin: 'window' + source_id
// BUILTIN_WINDOW_SOURCE_ID), with empty bucket_ids that are filled per-host by
// materializeActivityQueryV2. Unsourced legacy category rules are rewritten to
// reference `source: builtin_window`.
// ---------------------------------------------------------------------------

export interface CompiledCoverageSourceV2 {
  source_id: string;
  builtin?: BuiltinSource;
  bucket_ids: string[];
  interval_policy?: SourceIntervalPolicy;
  scope?: 'host' | 'global';
  bucket_hosts?: Record<string, string>;
  fields: string[];
  keeps_active?: boolean;
  host?: string;
}

export interface CompiledContextSourceV2 extends CompiledCoverageSourceV2 {
  conflict: 'base_wins';
}

export interface CompiledActiveSourceV2 {
  source_id: string;
  builtin?: BuiltinSource | 'afk';
  bucket_ids: string[];
  interval_policy?: SourceIntervalPolicy;
  scope?: 'host' | 'global';
  bucket_hosts?: Record<string, string>;
  host?: string;
}

export interface CompiledLegacyActiveTimeV2 {
  use_afk: boolean;
  include_audible: boolean;
  always_active_pattern: string;
}

export interface CompiledActivityQueryV2 {
  declared_source_ids?: string[];
  category_specs: Array<{
    id: string;
    name: string[];
    rule: RuleExpressionV2;
    priority?: number;
    set_priority?: number;
    requires?: string[];
  }>;
  context_sources: CompiledContextSourceV2[];
  activity_coverage_sources: CompiledCoverageSourceV2[];
  active_time_rule?: RuleExpressionV2;
  active_time_sources: CompiledActiveSourceV2[];
  app_title_source_id?: string;
  browser_focus_source_id?: string;
  /** Browser projection and audible activity use this configured source plan. */
  browser_source?: CompiledCoverageSourceV2;
  /**
   * Present when the profile keeps legacy active-time settings. Materialization
   * synthesizes an explicit AFK source/rule (and optional window always-active
   * branch) from these on capable hosts.
   */
  legacy_active_time?: CompiledLegacyActiveTimeV2;
  capabilities: string[];
}

export function allocateGeneratedSourceId(occupied: Set<string>, base: string): string {
  let candidate = base;
  let suffix = 2;
  while (occupied.has(candidate)) candidate = `${base}_${suffix++}`;
  occupied.add(candidate);
  return candidate;
}

export function sourceIntervalPolicy(
  source: Pick<SourceDefinitionV2, 'builtin' | 'interval_policy'>
): SourceIntervalPolicy {
  return (
    source.interval_policy ??
    (source.builtin === 'window' || source.builtin === 'browser' ? 'heartbeat' : 'exact')
  );
}

export function defaultBuiltinWindowSource(createsActivity = true): SourceDefinitionV2 {
  return {
    id: BUILTIN_WINDOW_SOURCE_ID,
    label: 'App & window',
    bucket_ids: [],
    builtin: 'window',
    fields: ['app', 'title'],
    interval_policy: 'heartbeat',
    ...(createsActivity ? { creates_activity: true } : {}),
  };
}

export function defaultBuiltinBrowserSource(): SourceDefinitionV2 {
  return {
    id: BUILTIN_BROWSER_SOURCE_ID,
    label: 'Browser tabs',
    bucket_ids: [],
    builtin: 'browser',
    fields: ['title', 'url', 'audible', 'incognito', 'tabCount'],
    field_types: {
      title: 'string',
      url: 'string',
      audible: 'scalar',
      incognito: 'scalar',
      tabCount: 'scalar',
    },
    interval_policy: 'heartbeat',
  };
}

export function defaultBuiltinStopwatchSource(): SourceDefinitionV2 {
  return {
    id: BUILTIN_STOPWATCH_SOURCE_ID,
    label: 'Stopwatch',
    bucket_ids: [],
    builtin: 'stopwatch',
    fields: ['label'],
    interval_policy: 'exact',
    creates_activity: true,
    keeps_active: true,
  };
}

export function defaultBuiltinSources(): SourceDefinitionV2[] {
  return [
    defaultBuiltinWindowSource(),
    defaultBuiltinBrowserSource(),
    defaultBuiltinStopwatchSource(),
  ];
}

export function initializeProfileSourceDefaults(
  profiles: ActivityProfileV2[]
): ActivityProfileV2[] {
  return profiles.map(profile => {
    const currentVersion = profile.source_defaults_version ?? 0;
    if (currentVersion >= SOURCE_DEFAULTS_VERSION) return profile;
    const sources = profile.sources.map(source => ({ ...source }));
    if (currentVersion < 2) {
      if (!sources.some(source => source.builtin === 'window')) {
        sources.unshift(defaultBuiltinWindowSource());
      }
      if (!sources.some(source => source.id === BUILTIN_BROWSER_SOURCE_ID)) {
        sources.push(defaultBuiltinBrowserSource());
      }
      if (!sources.some(source => source.id === BUILTIN_STOPWATCH_SOURCE_ID)) {
        sources.push(defaultBuiltinStopwatchSource());
      }
    }
    if (currentVersion < 3) {
      const stopwatch = sources.find(
        source => source.builtin === 'stopwatch' || source.id === BUILTIN_STOPWATCH_SOURCE_ID
      );
      if (stopwatch?.creates_activity && stopwatch.keeps_active === undefined) {
        stopwatch.keeps_active = true;
      }
    }
    if (currentVersion < 4) {
      for (const source of sources) {
        source.interval_policy ??= sourceIntervalPolicy(source);
      }
    }
    return {
      ...profile,
      source_defaults_version: SOURCE_DEFAULTS_VERSION,
      sources,
      app_title_source_id: profile.app_title_source_id ?? BUILTIN_WINDOW_SOURCE_ID,
      browser_focus_source_id: profile.browser_focus_source_id ?? BUILTIN_WINDOW_SOURCE_ID,
    };
  });
}

function isDefaultBuiltinWindowSource(source: SourceDefinitionV2): boolean {
  return isExactSourceDefinition(source, defaultBuiltinWindowSource());
}

function isExactSourceDefinition(
  source: SourceDefinitionV2,
  expected: SourceDefinitionV2
): boolean {
  const sourceKeys = Object.keys(source).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    sourceKeys.length !== expectedKeys.length ||
    sourceKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  return expectedKeys.every(key => {
    const actualValue = Reflect.get(source, key);
    const expectedValue = Reflect.get(expected, key);
    if (Array.isArray(expectedValue)) {
      return (
        Array.isArray(actualValue) &&
        actualValue.length === expectedValue.length &&
        actualValue.every((value, index) => value === expectedValue[index])
      );
    }
    if (expectedValue && typeof expectedValue === 'object') {
      return JSON.stringify(actualValue) === JSON.stringify(expectedValue);
    }
    return actualValue === expectedValue;
  });
}

export function isDefaultBuiltinSource(source: SourceDefinitionV2): boolean {
  if (isDefaultBuiltinWindowSource(source)) return true;
  return [defaultBuiltinBrowserSource(), defaultBuiltinStopwatchSource()].some(expected => {
    if (source.builtin === 'browser' && source.field_types === undefined) {
      const compatibleExpected = { ...expected };
      delete compatibleExpected.field_types;
      return isExactSourceDefinition(source, compatibleExpected);
    }
    return isExactSourceDefinition(source, expected);
  });
}

export function mergeSourceDefinitionChanges(
  current: SourceDefinitionV2[],
  draft: SourceDefinitionV2[],
  baseline: SourceDefinitionV2[]
): SourceDefinitionV2[] {
  const baselineById = new Map(baseline.map(source => [source.id, source]));
  const changedById = new Map(
    draft
      .filter(source => JSON.stringify(source) !== JSON.stringify(baselineById.get(source.id)))
      .map(source => [source.id, JSON.parse(JSON.stringify(source)) as SourceDefinitionV2])
  );
  const merged = current.map(source => changedById.get(source.id) ?? source);
  for (const [sourceId, source] of changedById) {
    if (!current.some(candidate => candidate.id === sourceId)) merged.push(source);
  }
  return merged;
}

interface RuleValidationState {
  nodes: number;
  sources: Set<string>;
}

export function validateRuleExpression(
  expression: RuleExpressionV2,
  path = 'rule',
  state: RuleValidationState = { nodes: 0, sources: new Set<string>() },
  depth = 1,
  allowNoneChildren = false
): string[] {
  if (depth > MAX_EXPRESSION_DEPTH) {
    return [`${path} exceeds maximum depth of ${MAX_EXPRESSION_DEPTH}`];
  }
  state.nodes++;
  if (state.nodes > MAX_EXPRESSION_NODES) {
    return [`${path} exceeds maximum node count of ${MAX_EXPRESSION_NODES}`];
  }
  if (!expression || typeof expression !== 'object') {
    return [`${path} must be an object`];
  }
  if (expression.type === 'none') {
    return [];
  }
  if (expression.type === 'regex') {
    const errors: string[] = [];
    if (!expression.regex) errors.push(`${path}.regex must be non-empty`);
    else if (expression.regex.length > MAX_REGEX_LENGTH) {
      errors.push(`${path}.regex exceeds maximum length of ${MAX_REGEX_LENGTH}`);
    } else if (!validateRegex(expression.regex)) errors.push(`${path}.regex is invalid`);
    if (expression.field !== undefined && expression.fields !== undefined) {
      errors.push(`${path} may not define both field and fields`);
    }
    if (
      expression.weight !== undefined &&
      (!Number.isInteger(expression.weight) ||
        expression.weight < MIN_RULE_RANK ||
        expression.weight > MAX_RULE_RANK)
    ) {
      errors.push(
        `${path}.weight must be an integer between ${MIN_RULE_RANK} and ${MAX_RULE_RANK}`
      );
    }
    if (expression.source) {
      state.sources.add(expression.source);
      if (state.sources.size > MAX_RULE_SOURCES) {
        errors.push(`${path} exceeds maximum source count of ${MAX_RULE_SOURCES}`);
      }
      if (expression.host !== undefined && !expression.host) {
        errors.push(`${path}.host must be non-empty`);
      }
    }
    return errors;
  }
  if (expression.type === 'all' || expression.type === 'any') {
    if (!Array.isArray(expression.rules) || expression.rules.length === 0) {
      return [`${path}.rules must contain at least one rule`];
    }
    return expression.rules.flatMap((rule, index) =>
      rule && typeof rule === 'object' && rule.type === 'none' && !allowNoneChildren
        ? [`${path}.rules[${index}] must be configured`]
        : validateRuleExpression(
            rule,
            `${path}.rules[${index}]`,
            state,
            depth + 1,
            allowNoneChildren
          )
    );
  }
  return [`${path}.type is unsupported`];
}

export function validateCategorySet(set: CategorySetV2): string[] {
  const errors: string[] = [];
  if (!set || typeof set !== 'object' || Array.isArray(set)) {
    return ['category set must be an object'];
  }
  if (set.schema_version !== RULES_SCHEMA_VERSION) errors.push('schema_version must be 2');
  if (typeof set.id !== 'string' || !set.id) errors.push('id must be a non-empty string');
  if (!Array.isArray(set.categories)) {
    errors.push('categories must be an array');
    return errors;
  }
  if (
    set.priority !== undefined &&
    (!Number.isInteger(set.priority) ||
      set.priority < MIN_RULE_RANK ||
      set.priority > MAX_RULE_RANK)
  ) {
    errors.push(
      `category set priority must be an integer between ${MIN_RULE_RANK} and ${MAX_RULE_RANK}`
    );
  }

  const ids = new Set<string>();
  let shapeInvalid = false;
  const validationState: RuleValidationState = { nodes: 0, sources: new Set<string>() };
  if (set.categories.length > MAX_CATEGORY_RULES) {
    errors.push(`categories exceed maximum count of ${MAX_CATEGORY_RULES}`);
  }
  for (const [index, category] of set.categories.entries()) {
    const path = `categories[${index}]`;
    if (!category || typeof category !== 'object' || Array.isArray(category)) {
      errors.push(`${path} must be an object`);
      shapeInvalid = true;
      continue;
    }
    if (typeof category.id !== 'string' || !category.id) {
      errors.push(`${path}.id must be a non-empty string`);
    }
    if (ids.has(category.id)) errors.push(`${path}.id is duplicated`);
    ids.add(category.id);
    const validName =
      Array.isArray(category.name) &&
      category.name.length > 0 &&
      category.name.every(segment => typeof segment === 'string' && !!segment);
    if (!validName) {
      errors.push(`${path}.name must contain non-empty string segments`);
    }
    if (!category.rule || typeof category.rule !== 'object' || Array.isArray(category.rule)) {
      errors.push(`${path}.rule must be an object`);
      shapeInvalid = true;
      continue;
    }
    if (category.requires !== undefined && !Array.isArray(category.requires)) {
      errors.push(`${path}.requires must be an array`);
      shapeInvalid = true;
    }
    if (
      category.priority !== undefined &&
      (!Number.isInteger(category.priority) ||
        category.priority < MIN_RULE_RANK ||
        category.priority > MAX_RULE_RANK)
    ) {
      errors.push(
        `${path}.priority must be an integer between ${MIN_RULE_RANK} and ${MAX_RULE_RANK}`
      );
    }
    if (category.simple_ui === true && !canUseSimpleCategoryUI(category)) {
      errors.push(`${path}.simple_ui is true but the category is not simple-compatible`);
    }
    errors.push(...validateRuleExpression(category.rule, `${path}.rule`, validationState));
  }
  // Cross-reference and cycle checks assume object categories and iterable
  // prerequisites. Shape diagnostics above are sufficient and must not be
  // replaced by an incidental JavaScript TypeError.
  if (shapeInvalid) return errors;
  const byId = new Map(set.categories.map(category => [category.id, category]));
  for (const [index, category] of set.categories.entries()) {
    for (const requirement of category.requires ?? []) {
      if (!ids.has(requirement)) {
        errors.push(`categories[${index}].requires references unknown id ${requirement}`);
      } else if (byId.get(requirement)?.rule?.type === 'none') {
        errors.push(
          `categories[${index}].requires references category without a matching rule ${requirement}`
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      errors.push(`category requirement cycle includes ${id}`);
      return;
    }
    if (visited.has(id) || !byId.has(id)) return;
    visiting.add(id);
    for (const requirement of byId.get(id)?.requires ?? []) visit(requirement);
    visiting.delete(id);
    visited.add(id);
  };
  for (const category of set.categories) visit(category.id);
  return errors;
}

export function validateActivityProfile(
  profile: ActivityProfileV2,
  categorySetIds: Set<string>
): string[] {
  const errors: string[] = [];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return ['activity profile must be an object'];
  }
  if (profile.schema_version !== RULES_SCHEMA_VERSION) errors.push('schema_version must be 2');
  if (typeof profile.id !== 'string' || !profile.id) errors.push('id must be a non-empty string');
  if (!Array.isArray(profile.category_set_ids)) {
    errors.push('category_set_ids must be a non-empty string array');
    return errors;
  }
  if (profile.category_set_ids.length === 0) {
    errors.push('activity profile must select at least one category set');
  }
  if (new Set(profile.category_set_ids).size !== profile.category_set_ids.length) {
    errors.push('activity profile category_set_ids must be unique');
  }
  for (const categorySetId of profile.category_set_ids) {
    if (!categorySetIds.has(categorySetId)) {
      errors.push(`activity profile references unknown category set ${categorySetId}`);
    }
  }

  if (!Array.isArray(profile.sources)) {
    errors.push('sources must be an array');
    return errors;
  }
  if (
    !profile.active_time ||
    typeof profile.active_time !== 'object' ||
    Array.isArray(profile.active_time)
  ) {
    errors.push('active_time must be an object');
    return errors;
  }
  const sourceIds = new Set<string>();
  let sourceShapeInvalid = false;
  if (profile.sources.length > MAX_RULE_SOURCES) {
    errors.push(`sources exceed maximum count of ${MAX_RULE_SOURCES}`);
  }
  for (const [index, source] of profile.sources.entries()) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      errors.push(`sources[${index}] must be an object`);
      sourceShapeInvalid = true;
      continue;
    }
    if (typeof source.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(source.id)) {
      errors.push(`sources[${index}].id is invalid`);
    }
    if (typeof source.label !== 'string' || !source.label) {
      errors.push(`sources[${index}].label must be non-empty`);
    }
    if (sourceIds.has(source.id)) errors.push(`sources[${index}].id is duplicated`);
    sourceIds.add(source.id);
    if (
      !Array.isArray(source.bucket_ids) ||
      source.bucket_ids.some(bucketId => typeof bucketId !== 'string' || !bucketId)
    ) {
      errors.push(`sources[${index}].bucket_ids must be a string array`);
      sourceShapeInvalid = true;
      continue;
    }
    if (
      !Array.isArray(source.fields) ||
      source.fields.some(field => typeof field !== 'string' || !field)
    ) {
      errors.push(`sources[${index}].fields must be a string array`);
      sourceShapeInvalid = true;
      continue;
    }
    if (source.fields.length === 0) {
      errors.push(`sources[${index}].fields must be non-empty`);
      sourceShapeInvalid = true;
      continue;
    }
    if (source.builtin !== undefined) {
      const expectedId = {
        window: BUILTIN_WINDOW_SOURCE_ID,
        browser: BUILTIN_BROWSER_SOURCE_ID,
        stopwatch: BUILTIN_STOPWATCH_SOURCE_ID,
      }[source.builtin];
      if (!expectedId || source.id !== expectedId) {
        errors.push(`sources[${index}].builtin is unsupported`);
      }
    } else if (source.bucket_ids.length === 0) {
      errors.push(`sources[${index}].bucket_ids must be non-empty`);
    }
    if (source.creates_activity !== undefined && typeof source.creates_activity !== 'boolean') {
      errors.push(`sources[${index}].creates_activity must be boolean`);
    }
    if (source.keeps_active !== undefined && typeof source.keeps_active !== 'boolean') {
      errors.push(`sources[${index}].keeps_active must be boolean`);
    }
    if (source.auto_generated !== undefined && typeof source.auto_generated !== 'boolean') {
      errors.push(`sources[${index}].auto_generated must be boolean`);
    }
    if (source.keeps_active && !source.creates_activity) {
      errors.push(`sources[${index}].keeps_active requires creates_activity`);
    }
    if (
      source.interval_policy !== undefined &&
      source.interval_policy !== 'exact' &&
      source.interval_policy !== 'heartbeat'
    ) {
      errors.push(`sources[${index}].interval_policy must be exact or heartbeat`);
    }
    if (source.host !== undefined && (typeof source.host !== 'string' || !source.host)) {
      errors.push(`sources[${index}].host must be non-empty`);
    }
    if (source.field_types !== undefined) {
      if (
        !source.field_types ||
        typeof source.field_types !== 'object' ||
        Array.isArray(source.field_types)
      ) {
        errors.push(`sources[${index}].field_types must be an object`);
      } else if (Object.keys(source.field_types).some(field => !source.fields.includes(field))) {
        errors.push(`sources[${index}].field_types may only describe configured fields`);
      } else if (
        Object.values(source.field_types).some(
          fieldType => fieldType !== 'string' && fieldType !== 'scalar'
        )
      ) {
        errors.push(`sources[${index}].field_types values must be string or scalar`);
      }
    }
    if (source.builtin && source.bucket_ids.length === 0) {
      continue;
    }
    const mappedBucketIds = Object.keys(source.bucket_hosts ?? {});
    const hasCompleteBucketHosts =
      mappedBucketIds.length === source.bucket_ids.length &&
      source.bucket_ids.every(bucketId => !!source.bucket_hosts?.[bucketId]) &&
      mappedBucketIds.every(bucketId => source.bucket_ids.includes(bucketId));
    const scope = source.scope ?? (source.host || hasCompleteBucketHosts ? 'host' : undefined);
    if (!scope) {
      errors.push(`sources[${index}].scope must be explicit`);
    } else if (scope !== 'host' && scope !== 'global') {
      errors.push(`sources[${index}].scope must be host or global`);
    } else if (scope === 'global') {
      if (source.host || source.bucket_hosts) {
        errors.push(`sources[${index}] global scope cannot define host ownership`);
      }
    } else if (source.host && source.bucket_hosts) {
      errors.push(`sources[${index}] host scope must use either host or bucket_hosts`);
    } else if (!source.host && !hasCompleteBucketHosts) {
      errors.push(`sources[${index}] host scope requires complete ownership`);
    }
    if (new Set(source.bucket_ids).size !== source.bucket_ids.length) {
      errors.push(`sources[${index}].bucket_ids must be unique`);
    }
    if (new Set(source.fields).size !== source.fields.length) {
      errors.push(`sources[${index}].fields must be unique`);
    }
    if (
      source.bucket_hosts &&
      (source.bucket_ids.some(bucketId => !source.bucket_hosts?.[bucketId]) ||
        Object.keys(source.bucket_hosts).some(bucketId => !source.bucket_ids.includes(bucketId)))
    ) {
      errors.push(`sources[${index}].bucket_hosts is invalid`);
    } else {
      for (const host of Object.values(source.bucket_hosts ?? {})) {
        if (!host) {
          errors.push(`sources[${index}].bucket_hosts is invalid`);
          break;
        }
      }
    }
  }
  if (sourceShapeInvalid) return errors;
  if (
    profile.app_title_source_id !== undefined &&
    typeof profile.app_title_source_id !== 'string'
  ) {
    errors.push('app_title_source_id must be a string');
  }
  if (
    profile.browser_focus_source_id !== undefined &&
    typeof profile.browser_focus_source_id !== 'string'
  ) {
    errors.push('browser_focus_source_id must be a string');
  }
  if (profile.active_time.type === 'expression') {
    errors.push(
      ...validateRuleExpression(
        profile.active_time.rule,
        'active_time.rule',
        { nodes: 0, sources: new Set<string>() },
        1,
        true
      )
    );
    errors.push(...validateActiveTimeSources(profile.active_time.rule));
    for (const sourceId of collectRuleSourceIds(profile.active_time.rule)) {
      const source = profile.sources.find(candidate => candidate.id === sourceId);
      if (!source) {
        errors.push(`active_time.rule references unknown source ${sourceId}`);
      }
      // v2 allows explicit `source: builtin_window` references; the builtin window
      // source compiles into an ordinary namespaced coverage/context source.
    }
  }
  return errors;
}

function validateActiveTimeSources(
  expression: RuleExpressionV2,
  path = 'active_time.rule'
): string[] {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) {
    return [`${path} must be an object`];
  }
  if (expression.type === 'none') {
    return [];
  }
  if (expression.type === 'regex') {
    return expression.source ? [] : [`${path}.source must be non-empty`];
  }
  if (expression.type === 'all' || expression.type === 'any') {
    if (!Array.isArray(expression.rules)) return [`${path}.rules must be an array`];
    return expression.rules.flatMap((rule, index) =>
      validateActiveTimeSources(rule, `${path}.rules[${index}]`)
    );
  }
  return [];
}

export function collectRuleSourceIds(expression: RuleExpressionV2): Set<string> {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return new Set();
  if (expression.type === 'regex') {
    return new Set(expression.source ? [expression.source] : []);
  }
  if (expression.type === 'all' || expression.type === 'any') {
    if (!Array.isArray(expression.rules)) return new Set();
    return new Set(expression.rules.flatMap(rule => [...collectRuleSourceIds(rule)]));
  }
  return new Set();
}

export function validateProfileRulesV2(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[]
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(categorySets)) return ['category_sets_v2 must be an array'];
  const categoryShapeInvalid = categorySets.some(
    set =>
      !set ||
      typeof set !== 'object' ||
      Array.isArray(set) ||
      !Array.isArray(set.categories) ||
      set.categories.some(
        category =>
          !category ||
          typeof category !== 'object' ||
          Array.isArray(category) ||
          !category.rule ||
          typeof category.rule !== 'object' ||
          Array.isArray(category.rule) ||
          (category.requires !== undefined && !Array.isArray(category.requires))
      )
  );
  const categorySetIds = new Set(
    categorySets
      .filter(set => !!set && typeof set === 'object' && !Array.isArray(set))
      .map(set => set.id)
  );
  errors.push(...validateActivityProfile(profile, categorySetIds));
  const profileShapeInvalid =
    !profile ||
    typeof profile !== 'object' ||
    Array.isArray(profile) ||
    !Array.isArray(profile.category_set_ids) ||
    !Array.isArray(profile.sources) ||
    profile.sources.some(
      source =>
        !source ||
        typeof source !== 'object' ||
        Array.isArray(source) ||
        !Array.isArray(source.bucket_ids) ||
        !Array.isArray(source.fields)
    ) ||
    !profile.active_time ||
    typeof profile.active_time !== 'object' ||
    Array.isArray(profile.active_time);
  if (profileShapeInvalid || categoryShapeInvalid) {
    for (const [index, set] of categorySets.entries()) {
      errors.push(...validateCategorySet(set).map(error => `category_sets_v2[${index}].${error}`));
    }
    return errors;
  }
  const selectedSets = profile.category_set_ids
    .map(id => categorySets.find(candidate => candidate?.id === id))
    .filter((set): set is CategorySetV2 => !!set);
  const selectedCategoryCount = selectedSets.reduce(
    (count, set) => count + (Array.isArray(set.categories) ? set.categories.length : 0),
    0
  );
  if (selectedCategoryCount > MAX_CATEGORY_RULES) {
    errors.push(
      `category_set_ids select ${selectedCategoryCount} category rules; maximum is ${MAX_CATEGORY_RULES}`
    );
  }
  const aggregateState: RuleValidationState = { nodes: 0, sources: new Set<string>() };
  for (const set of selectedSets) {
    if (!Array.isArray(set.categories)) continue;
    for (const [index, category] of set.categories.entries()) {
      if (category?.rule) {
        errors.push(
          ...validateRuleExpression(
            category.rule,
            `category_set_ids[${set.id}].categories[${index}].rule`,
            aggregateState
          )
        );
      }
    }
  }
  if (aggregateState.sources.size > MAX_RULE_SOURCES) {
    errors.push(`selected category rules exceed maximum source count of ${MAX_RULE_SOURCES}`);
  }
  const windowSource = profile.sources.find(source => source.builtin === 'window');
  for (const set of selectedSets) {
    errors.push(...validateCategorySet(set).map(error => `${set.id}: ${error}`));
    if (
      !windowSource &&
      set.categories.some(
        category =>
          category &&
          typeof category === 'object' &&
          category.rule &&
          category.rule.type !== 'none' &&
          expressionUsesLegacyWindow(category.rule)
      )
    ) {
      errors.push(
        `category set ${set.id}: unsourced category rules require the App & window source`
      );
    }
    for (const category of set.categories) {
      if (!category || typeof category !== 'object' || !category.rule) continue;
      for (const sourceId of collectRuleSourceIds(category.rule)) {
        if (!profile.sources.some(candidate => candidate.id === sourceId)) {
          errors.push(`category ${set.id}/${category.id} references unknown source ${sourceId}`);
        }
      }
    }
  }
  if (profile.active_time.type === 'legacy' && profile.active_time.always_active_pattern) {
    if (!windowSource) {
      errors.push('active_time.always_active_pattern requires a configured App & window source');
    } else if (!windowSource.fields.some(field => field === 'app' || field === 'title')) {
      errors.push(
        'active_time.always_active_pattern requires the App & window source to expose app or title'
      );
    }
  }
  return errors;
}

// Stable import surface for external query generators.
export * from '~/util/rulesV2Migration';
export {
  compileActivityQueryV2,
  compileProfileQueryOptions,
  compiledCategoryId,
} from '~/util/rulesV2Compilation';
