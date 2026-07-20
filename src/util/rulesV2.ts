import type { Category } from '~/util/classes';
import { validateRegex } from '~/util/validate';

export const RULES_SCHEMA_VERSION = 2 as const;
export const SOURCE_DEFAULTS_VERSION = 3;
export const MAX_EXPRESSION_DEPTH = 32;
export const MAX_EXPRESSION_NODES = 4096;
export const MAX_REGEX_LENGTH = 4096;
export const MAX_CATEGORY_RULES = 1000;
export const MAX_RULE_SOURCES = 128;
export const BUILTIN_WINDOW_SOURCE_ID = 'builtin_window';
export const BUILTIN_BROWSER_SOURCE_ID = 'browser';
export const BUILTIN_STOPWATCH_SOURCE_ID = 'stopwatch';
export type BuiltinSource = 'window' | 'browser' | 'stopwatch';

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

export interface CompiledProfileQueryOptions {
  category_specs: CategoryRuleV2[];
  context_sources: Array<{
    source_id: string;
    bucket_ids: string[];
    scope?: 'host' | 'global';
    bucket_hosts?: Record<string, string>;
    fields: string[];
    conflict: 'base_wins';
    host?: string;
  }>;
  active_time_rule?: RuleExpressionV2;
  active_time_sources?: Array<{
    source_id: string;
    bucket_ids: string[];
    scope?: 'host' | 'global';
    bucket_hosts?: Record<string, string>;
    host?: string;
  }>;
  activity_coverage_sources: Array<{
    source_id: string;
    bucket_ids: string[];
    scope?: 'host' | 'global';
    bucket_hosts?: Record<string, string>;
    fields: string[];
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
// Unlike CompiledProfileQueryOptions (retained for the legacy query path and
// un-migrated callers), this representation never carries legacy_window_mode.
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
  category_specs: Array<{
    id: string;
    name: string[];
    rule: RuleExpressionV2;
    priority?: number;
    requires?: string[];
  }>;
  context_sources: CompiledContextSourceV2[];
  activity_coverage_sources: CompiledCoverageSourceV2[];
  active_time_rule?: RuleExpressionV2;
  active_time_sources: CompiledActiveSourceV2[];
  app_title_source_id?: string;
  browser_focus_source_id?: string;
  /**
   * Present when the profile keeps legacy active-time settings. Materialization
   * synthesizes an explicit AFK source/rule (and optional window always-active
   * branch) from these on capable hosts.
   */
  legacy_active_time?: CompiledLegacyActiveTimeV2;
  capabilities: string[];
}

export function defaultBuiltinWindowSource(createsActivity = true): SourceDefinitionV2 {
  return {
    id: BUILTIN_WINDOW_SOURCE_ID,
    label: 'App & window',
    bucket_ids: [],
    builtin: 'window',
    fields: ['app', 'title'],
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
  };
}

export function defaultBuiltinStopwatchSource(): SourceDefinitionV2 {
  return {
    id: BUILTIN_STOPWATCH_SOURCE_ID,
    label: 'Stopwatch',
    bucket_ids: [],
    builtin: 'stopwatch',
    fields: ['label'],
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
    return Array.isArray(expectedValue)
      ? Array.isArray(actualValue) &&
          actualValue.length === expectedValue.length &&
          actualValue.every((value, index) => value === expectedValue[index])
      : actualValue === expectedValue;
  });
}

function isDefaultBuiltinSource(source: SourceDefinitionV2): boolean {
  if (isDefaultBuiltinWindowSource(source)) return true;
  return [defaultBuiltinBrowserSource(), defaultBuiltinStopwatchSource()].some(expected =>
    isExactSourceDefinition(source, expected)
  );
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

export interface LegacyRule {
  type: 'regex' | 'none' | null;
  regex?: string;
  ignore_case?: boolean;
  select_keys?: string[];
}

export type RulesEditorMode = 'simple' | 'advanced';

export interface CategorySimplificationLoss {
  id: string;
  path: string;
  reasons: Array<'rule' | 'priority' | 'prerequisites'>;
}

export interface SourceSimplificationLoss {
  id: string;
  label: string;
}

export interface RulesSimplificationLossSet {
  categories: CategorySimplificationLoss[];
  active_time: RuleExpressionV2 | null;
  sources: SourceSimplificationLoss[];
}

export function legacyRuleToV2(rule: LegacyRule): RuleExpressionV2 {
  if (!rule || rule.type === 'none' || rule.type === null) {
    return { type: 'none' };
  }

  const expression: RegexExpressionV2 = {
    type: 'regex',
    regex: rule.regex ?? '',
    weight: 0,
  };
  if (rule.ignore_case) {
    expression.ignore_case = true;
  }
  if (rule.select_keys?.length === 1) {
    expression.field = rule.select_keys[0];
  } else if (rule.select_keys && rule.select_keys.length > 1) {
    expression.fields = [...rule.select_keys];
  }
  return expression;
}

export function isLegacyCompatibleRuleV2(
  expression: RuleExpressionV2
): expression is NoneExpressionV2 | RegexExpressionV2 {
  if (expression.type === 'none') return true;
  return (
    expression.type === 'regex' &&
    !expression.source &&
    !expression.host &&
    !expression.negate &&
    (expression.weight === undefined || expression.weight === 0) &&
    (expression.value_mode === undefined || expression.value_mode === 'string')
  );
}

export function canUseSimpleCategoryUI(
  category: Pick<CategoryRuleV2, 'rule' | 'priority' | 'requires'>
): boolean {
  return (
    isLegacyCompatibleRuleV2(category.rule) &&
    (category.priority === undefined || category.priority === 0) &&
    (category.requires?.length ?? 0) === 0
  );
}

function normalizeCategoryRuleV2(category: CategoryRuleV2): CategoryRuleV2 {
  const current = { ...category };
  delete current.legacy_rule;
  const normalized: CategoryRuleV2 = {
    ...current,
    name: [...category.name],
    rule: JSON.parse(JSON.stringify(category.rule)),
    ...(category.requires ? { requires: [...category.requires] } : {}),
    ...(category.data ? { data: { ...category.data } } : {}),
  };
  if (typeof normalized.simple_ui !== 'boolean') {
    normalized.simple_ui = canUseSimpleCategoryUI(normalized);
  }
  return normalized;
}

export function v2RuleToLegacy(expression: RuleExpressionV2): LegacyRule | undefined {
  if (!isLegacyCompatibleRuleV2(expression)) return undefined;
  if (expression.type === 'none') return { type: 'none' };
  const legacy: LegacyRule = {
    type: 'regex',
    regex: expression.regex,
  };
  if (expression.ignore_case !== undefined) legacy.ignore_case = expression.ignore_case;
  if (expression.field) legacy.select_keys = [expression.field];
  else if (expression.fields) legacy.select_keys = [...expression.fields];
  return legacy;
}

function stableCategoryId(setId: string, category: Category): string {
  return `${setId}:${category.name.map(encodeURIComponent).join('/')}`;
}

export function migrateCategorySet(categories: Category[], id = 'default'): CategorySetV2 {
  return {
    schema_version: RULES_SCHEMA_VERSION,
    id,
    categories: categories.map(category => {
      const legacyRule = category.rule as LegacyRule;
      return {
        id: stableCategoryId(id, category),
        name: [...category.name],
        rule: legacyRuleToV2(legacyRule),
        simple_ui: true,
        ...(category.data ? { data: { ...category.data } } : {}),
      };
    }),
  };
}

export function categorySetToLegacyClasses(
  set: CategorySetV2,
  _fallbackClasses: Category[] = []
): Category[] {
  return set.categories.map(category => ({
    name: [...category.name],
    rule: (canUseSimpleCategoryUI(category) ? v2RuleToLegacy(category.rule) : undefined) ?? {
      type: 'none',
    },
    ...(category.data ? { data: { ...category.data } } : {}),
  }));
}

export function migrateLegacySettings(input: {
  classes: Category[];
  always_active_pattern?: string;
  include_audible?: boolean;
}): {
  category_sets_v2: CategorySetV2[];
  activity_profiles_v2: ActivityProfileV2[];
} {
  return {
    category_sets_v2: [migrateCategorySet(input.classes)],
    activity_profiles_v2: [
      {
        schema_version: RULES_SCHEMA_VERSION,
        source_defaults_version: SOURCE_DEFAULTS_VERSION,
        id: 'default',
        category_set_ids: ['default'],
        sources: defaultBuiltinSources(),
        app_title_source_id: BUILTIN_WINDOW_SOURCE_ID,
        browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
        active_time: {
          type: 'legacy',
          use_afk: true,
          include_audible: input.include_audible ?? true,
          always_active_pattern: input.always_active_pattern ?? '',
        },
      },
    ],
  };
}

export function resolveRulesV2Settings(input: {
  activity_profiles_v2: ActivityProfileV2[] | null;
  category_sets_v2: CategorySetV2[] | null;
  classes: Category[];
  always_active_pattern?: string;
}): {
  activity_profiles_v2: ActivityProfileV2[];
  category_sets_v2: CategorySetV2[];
  migrated: boolean;
} {
  const migrated = migrateLegacySettings(input);
  const profile = input.activity_profiles_v2?.[0] ?? migrated.activity_profiles_v2[0];
  const preferredSetId = profile.category_set_ids[0];
  const categorySet =
    input.category_sets_v2?.find(set => set.id === preferredSetId) ??
    input.category_sets_v2?.[0] ??
    migrated.category_sets_v2[0];

  const normalizedSet: CategorySetV2 = {
    ...categorySet,
    categories: categorySet.categories.map(normalizeCategoryRuleV2),
  };

  const normalizedProfile: ActivityProfileV2 = {
    ...profile,
    category_set_ids: profile.category_set_ids.includes(normalizedSet.id)
      ? [normalizedSet.id, ...profile.category_set_ids.filter(id => id !== normalizedSet.id)]
      : [normalizedSet.id],
    // Do not force-reinject the default window source on every load: an Advanced
    // profile that legitimately removed it must round-trip unchanged. The window
    // source is seeded only by migrateLegacySettings when creating a fresh profile.
    sources: profile.sources.map(source => {
      const normalized: SourceDefinitionV2 = {
        ...source,
        bucket_ids: [...source.bucket_ids],
        fields: [...source.fields],
        ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
      };
      if (normalized.auto_generated && normalized.host) {
        normalized.bucket_hosts ??= Object.fromEntries(
          normalized.bucket_ids.map(bucketId => [bucketId, normalized.host as string])
        );
        delete normalized.host;
      }
      if (!normalized.scope && (normalized.host || normalized.bucket_hosts)) {
        normalized.scope = 'host';
      }
      const activityMode =
        normalized.activity_mode ??
        (normalized.role === 'activity' || normalized.merge_mode === 'replace'
          ? 'replace'
          : normalized.role === 'background' || normalized.merge_mode === 'enrich'
          ? 'fill-gaps'
          : undefined);
      normalized.creates_activity ??= activityMode !== undefined;
      if (!normalized.creates_activity) delete normalized.creates_activity;
      delete normalized.activity_mode;
      delete normalized.role;
      delete normalized.merge_mode;
      delete normalized.priority;
      delete normalized.legacy_fields;
      delete normalized.canonical_fields;
      return normalized;
    }),
    active_time: JSON.parse(JSON.stringify(profile.active_time)),
  };

  return {
    activity_profiles_v2: [
      normalizedProfile,
      ...(input.activity_profiles_v2 ?? []).filter(candidate => candidate.id !== profile.id),
    ],
    category_sets_v2: [
      normalizedSet,
      ...(input.category_sets_v2 ?? []).filter(candidate => candidate.id !== normalizedSet.id),
    ],
    migrated: input.activity_profiles_v2 === null || input.category_sets_v2 === null,
  };
}

export function inferRulesEditorMode(
  profile: ActivityProfileV2,
  categorySet: CategorySetV2
): RulesEditorMode {
  const hasEveryDefaultSource =
    profile.sources.length === defaultBuiltinSources().length &&
    profile.sources.every(isDefaultBuiltinSource);
  if (
    !hasEveryDefaultSource ||
    profile.app_title_source_id !== BUILTIN_WINDOW_SOURCE_ID ||
    profile.browser_focus_source_id !== BUILTIN_WINDOW_SOURCE_ID ||
    profile.active_time.type === 'expression' ||
    categorySet.categories.some(category => category.simple_ui !== true)
  ) {
    return 'advanced';
  }
  return 'simple';
}

function expressionUsesLegacyWindow(expression: RuleExpressionV2): boolean {
  if (expression.type === 'regex') return !expression.source;
  if (expression.type === 'all' || expression.type === 'any') {
    return expression.rules.some(expressionUsesLegacyWindow);
  }
  return false;
}

export function getLegacyWindowMode(
  profile: ActivityProfileV2,
  categorySet: CategorySetV2
): 'activity' | 'context' | 'none' {
  const windowSource = profile.sources.find(source => source.builtin === 'window');
  if (windowSource) {
    if (windowSource.creates_activity) return 'activity';
  } else if (inferRulesEditorMode(profile, categorySet) === 'simple') {
    return 'activity';
  }
  if (
    categorySet.categories.some(
      category => category.rule.type !== 'none' && expressionUsesLegacyWindow(category.rule)
    )
  ) {
    return windowSource ? 'context' : 'none';
  }
  if (profile.active_time.type === 'legacy' && profile.active_time.always_active_pattern) {
    return 'context';
  }
  return 'none';
}

export function computeRulesSimplificationLosses(
  profile: ActivityProfileV2,
  categorySet: CategorySetV2
): RulesSimplificationLossSet {
  return {
    categories: categorySet.categories.flatMap(category => {
      const reasons: CategorySimplificationLoss['reasons'] = [];
      if (!isLegacyCompatibleRuleV2(category.rule)) {
        reasons.push('rule');
      }
      if ((category.priority ?? 0) !== 0) {
        reasons.push('priority');
      }
      if ((category.requires?.length ?? 0) > 0) {
        reasons.push('prerequisites');
      }
      return reasons.length ? [{ id: category.id, path: category.name.join(' > '), reasons }] : [];
    }),
    active_time:
      profile.active_time.type === 'expression'
        ? JSON.parse(JSON.stringify(profile.active_time.rule))
        : null,
    sources: profile.sources
      .filter(source => !isDefaultBuiltinSource(source))
      .map(source => ({
        id: source.id,
        label: source.label,
      })),
  };
}

export function hasRulesSimplificationLosses(losses: RulesSimplificationLossSet): boolean {
  return losses.categories.length > 0 || losses.active_time !== null || losses.sources.length > 0;
}

export function applyRulesSimplification(input: {
  profile: ActivityProfileV2;
  categorySet: CategorySetV2;
  always_active_pattern: string;
}): {
  activity_profiles_v2: ActivityProfileV2[];
  category_sets_v2: CategorySetV2[];
  classes: Category[];
} {
  const categorySet: CategorySetV2 = {
    ...input.categorySet,
    categories: input.categorySet.categories.map(category => {
      const rule = isLegacyCompatibleRuleV2(category.rule)
        ? JSON.parse(JSON.stringify(category.rule))
        : { type: 'none' as const };
      const simplified: CategoryRuleV2 = {
        ...category,
        name: [...category.name],
        rule,
        simple_ui: true,
        ...(category.data ? { data: { ...category.data } } : {}),
      };
      delete simplified.priority;
      delete simplified.requires;
      return simplified;
    }),
  };
  const profile: ActivityProfileV2 = {
    ...input.profile,
    source_defaults_version: SOURCE_DEFAULTS_VERSION,
    category_set_ids: [categorySet.id],
    sources: defaultBuiltinSources(),
    app_title_source_id: BUILTIN_WINDOW_SOURCE_ID,
    browser_focus_source_id: BUILTIN_WINDOW_SOURCE_ID,
    active_time: {
      type: 'legacy',
      use_afk: true,
      include_audible: true,
      always_active_pattern: input.always_active_pattern,
    },
  };
  return {
    activity_profiles_v2: [profile],
    category_sets_v2: [categorySet],
    classes: categorySetToLegacyClasses(categorySet),
  };
}

interface RuleValidationState {
  nodes: number;
  sources: Set<string>;
}

export function validateRuleExpression(
  expression: RuleExpressionV2,
  path = 'rule',
  state: RuleValidationState = { nodes: 0, sources: new Set<string>() },
  depth = 1
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
    if (expression.weight !== undefined && !Number.isInteger(expression.weight)) {
      errors.push(`${path}.weight must be an integer`);
    }
    if (expression.field && expression.fields) {
      errors.push(`${path} cannot contain both field and fields`);
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
      rule.type === 'none'
        ? [`${path}.rules[${index}] must be configured`]
        : validateRuleExpression(rule, `${path}.rules[${index}]`, state, depth + 1)
    );
  }
  return [`${path}.type is unsupported`];
}

export function validateCategorySet(set: CategorySetV2): string[] {
  const errors: string[] = [];
  if (set.schema_version !== RULES_SCHEMA_VERSION) errors.push('unsupported schema_version');
  if (!set.id) errors.push('category set id must be non-empty');

  const ids = new Set<string>();
  const validationState: RuleValidationState = { nodes: 0, sources: new Set<string>() };
  if (set.categories.length > MAX_CATEGORY_RULES) {
    errors.push(`categories exceed maximum count of ${MAX_CATEGORY_RULES}`);
  }
  for (const [index, category] of set.categories.entries()) {
    const path = `categories[${index}]`;
    if (!category.id) errors.push(`${path}.id must be non-empty`);
    if (ids.has(category.id)) errors.push(`${path}.id is duplicated`);
    ids.add(category.id);
    if (!category.name.length || category.name.some(segment => !segment)) {
      errors.push(`${path}.name must contain non-empty segments`);
    }
    if (category.priority !== undefined && !Number.isInteger(category.priority)) {
      errors.push(`${path}.priority must be an integer`);
    }
    if (category.simple_ui === true && !canUseSimpleCategoryUI(category)) {
      errors.push(`${path}.simple_ui is true but the category is not simple-compatible`);
    }
    errors.push(...validateRuleExpression(category.rule, `${path}.rule`, validationState));
  }
  const byId = new Map(set.categories.map(category => [category.id, category]));
  for (const [index, category] of set.categories.entries()) {
    for (const requirement of category.requires ?? []) {
      if (!ids.has(requirement)) {
        errors.push(`categories[${index}].requires references unknown id ${requirement}`);
      } else if (byId.get(requirement)?.rule.type === 'none') {
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
  if (profile.schema_version !== RULES_SCHEMA_VERSION) errors.push('unsupported schema_version');
  if (!profile.id) errors.push('activity profile id must be non-empty');
  if (profile.category_set_ids.length === 0) {
    errors.push('activity profile must select at least one category set');
  } else if (profile.category_set_ids.length !== 1) {
    errors.push('activity profile must select exactly one category set');
  }
  for (const categorySetId of profile.category_set_ids) {
    if (!categorySetIds.has(categorySetId)) {
      errors.push(`activity profile references unknown category set ${categorySetId}`);
    }
  }

  const sourceIds = new Set<string>();
  if (profile.sources.length > MAX_RULE_SOURCES) {
    errors.push(`sources exceed maximum count of ${MAX_RULE_SOURCES}`);
  }
  for (const [index, source] of profile.sources.entries()) {
    if (!/^[A-Za-z0-9_-]+$/.test(source.id)) {
      errors.push(`sources[${index}].id is invalid`);
    }
    if (sourceIds.has(source.id)) errors.push(`sources[${index}].id is duplicated`);
    sourceIds.add(source.id);
    if (source.builtin) {
      const expectedId = {
        window: BUILTIN_WINDOW_SOURCE_ID,
        browser: BUILTIN_BROWSER_SOURCE_ID,
        stopwatch: BUILTIN_STOPWATCH_SOURCE_ID,
      }[source.builtin];
      if (source.id !== expectedId) {
        errors.push(`sources[${index}].builtin is unsupported`);
      }
    } else if (source.bucket_ids.length === 0) {
      errors.push(`sources[${index}].bucket_ids must be non-empty`);
    }
    if (source.fields.length === 0) {
      errors.push(`sources[${index}].fields must be non-empty`);
    }
    if (source.creates_activity !== undefined && typeof source.creates_activity !== 'boolean') {
      errors.push(`sources[${index}].creates_activity must be boolean`);
    }
    if (source.keeps_active !== undefined && typeof source.keeps_active !== 'boolean') {
      errors.push(`sources[${index}].keeps_active must be boolean`);
    }
    if (source.keeps_active && !source.creates_activity) {
      errors.push(`sources[${index}].keeps_active requires creates_activity`);
    }
    if (source.host !== undefined && !source.host) {
      errors.push(`sources[${index}].host must be non-empty`);
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
    errors.push(...validateRuleExpression(profile.active_time.rule, 'active_time.rule'));
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
  if (expression.type === 'none') {
    return [`${path} must contain at least one matching condition`];
  }
  if (expression.type === 'regex') {
    return expression.source ? [] : [`${path}.source must be non-empty`];
  }
  if (expression.type === 'all' || expression.type === 'any') {
    return expression.rules.flatMap((rule, index) =>
      validateActiveTimeSources(rule, `${path}.rules[${index}]`)
    );
  }
  return [];
}

export function collectRuleSourceIds(expression: RuleExpressionV2): Set<string> {
  if (expression.type === 'regex') {
    return new Set(expression.source ? [expression.source] : []);
  }
  if (expression.type === 'all' || expression.type === 'any') {
    return new Set(expression.rules.flatMap(rule => [...collectRuleSourceIds(rule)]));
  }
  return new Set();
}

export function validateProfileRulesV2(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[]
): string[] {
  const errors: string[] = [];
  errors.push(...validateActivityProfile(profile, new Set(categorySets.map(set => set.id))));
  const set = categorySets.find(candidate => candidate.id === profile.category_set_ids[0]);
  if (set) {
    errors.push(...validateCategorySet(set));
    for (const category of set.categories) {
      for (const sourceId of collectRuleSourceIds(category.rule)) {
        const source = profile.sources.find(candidate => candidate.id === sourceId);
        if (!source) {
          errors.push(`category ${category.id} references unknown source ${sourceId}`);
        }
        // v2 allows explicit `source: builtin_window` references; the builtin window
        // source compiles into an ordinary namespaced coverage/context source.
      }
    }
  }
  return errors;
}

export function compileProfileQueryOptions(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[],
  capabilities: string[]
): CompiledProfileQueryOptions {
  const errors = validateProfileRulesV2(profile, categorySets);
  if (errors.length > 0) {
    throw new Error(`Invalid v2 rules settings: ${errors.join('; ')}`);
  }
  if (!capabilities.includes('query.categorize_v2.v1')) {
    throw new Error('Flexible categorization requires server capability query.categorize_v2.v1');
  }
  const categorySet = categorySets.find(candidate => candidate.id === profile.category_set_ids[0]);
  if (!categorySet) {
    throw new Error(`Category set ${profile.category_set_ids[0]} is unavailable`);
  }

  const categorySpecs = categorySet.categories.map(category => ({
    id: category.id,
    name: [...category.name],
    rule: JSON.parse(JSON.stringify(category.rule)) as RuleExpressionV2,
    ...(category.priority !== undefined ? { priority: category.priority } : {}),
    requires: category.requires ? [...category.requires] : undefined,
  }));
  const legacyWindowMode = getLegacyWindowMode(profile, categorySet);

  const categorySourceIds = new Set(
    categorySet.categories.flatMap(category => [...collectRuleSourceIds(category.rule)])
  );
  const contextSources = profile.sources
    .filter(source => source.builtin !== 'window')
    .filter(source => categorySourceIds.has(source.id) && !source.creates_activity)
    .map(source => ({
      source_id: source.id,
      bucket_ids: [...source.bucket_ids],
      scope: source.scope,
      ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
      fields: [...source.fields],
      conflict: 'base_wins' as const,
      host: source.host,
      ...(source.builtin ? { builtin: source.builtin } : {}),
    }));
  if (
    (contextSources.length > 0 || legacyWindowMode === 'context') &&
    !capabilities.includes('query.merge_subwatcher_fields.source_namespace.v1')
  ) {
    throw new Error(
      'Context enrichment requires server capability ' +
        'query.merge_subwatcher_fields.source_namespace.v1'
    );
  }
  const windowSource =
    profile.sources.find(source => source.builtin === 'window') ?? defaultBuiltinWindowSource();
  const result: CompiledProfileQueryOptions = {
    category_specs: categorySpecs,
    context_sources: contextSources,
    activity_coverage_sources: profile.sources
      .filter(source => source.builtin !== 'window')
      .filter(source => source.creates_activity)
      .filter(
        source =>
          source.builtin !== 'stopwatch' ||
          capabilities.includes('query.merge_subwatcher_fields.source_namespace.v1')
      )
      .map(source => ({
        source_id: source.id,
        bucket_ids: [...source.bucket_ids],
        scope: source.scope,
        ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
        fields: [...source.fields],
        host: source.host,
        ...(source.builtin ? { builtin: source.builtin } : {}),
      })),
    activity_sources: [],
    background_sources: [],
    capabilities: [...capabilities],
    legacy_window_mode: legacyWindowMode,
    legacy_window_fields: [...windowSource.fields],
  };
  if (
    result.activity_coverage_sources.length > 0 &&
    !capabilities.includes('query.merge_subwatcher_fields.source_namespace.v1')
  ) {
    throw new Error(
      'Activity coverage sources require server capability ' +
        'query.merge_subwatcher_fields.source_namespace.v1'
    );
  }
  if (profile.active_time.type === 'expression') {
    if (!capabilities.includes('query.active_periods_v2.v1')) {
      throw new Error(
        'Active-time expressions require server capability query.active_periods_v2.v1'
      );
    }
    result.active_time_rule = profile.active_time.rule;
    const activeSourceIds = collectRuleSourceIds(profile.active_time.rule);
    result.active_time_sources = profile.sources
      .filter(source => source.builtin !== 'window')
      .filter(source => activeSourceIds.has(source.id))
      .map(source => ({
        source_id: source.id,
        bucket_ids: [...source.bucket_ids],
        scope: source.scope,
        ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
        host: source.host,
        ...(source.builtin ? { builtin: source.builtin } : {}),
      }));
  }
  return result;
}

function rewriteUnsourcedToWindow(expression: RuleExpressionV2): RuleExpressionV2 {
  if (expression.type === 'regex') {
    return expression.source ? expression : { ...expression, source: BUILTIN_WINDOW_SOURCE_ID };
  }
  if (expression.type === 'all' || expression.type === 'any') {
    return { ...expression, rules: expression.rules.map(rewriteUnsourcedToWindow) };
  }
  return expression;
}

// Compiles a v2 profile into the v2-pure representation. The configured default
// window source becomes an ordinary namespaced coverage/context source; unsourced
// legacy category rules are rewritten to `source: builtin_window`. No
// legacy_window_mode/root injection is ever produced.
export function compileActivityQueryV2(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[],
  capabilities: string[]
): CompiledActivityQueryV2 {
  const errors = validateProfileRulesV2(profile, categorySets);
  if (errors.length > 0) {
    throw new Error(`Invalid v2 rules settings: ${errors.join('; ')}`);
  }
  if (
    profile.active_time.type === 'legacy' &&
    profile.active_time.always_active_pattern &&
    !profile.sources.some(source => source.builtin === 'window')
  ) {
    // Capable v2 path: removing the window source while an always-active pattern
    // still depends on it must surface as validation rather than being silently
    // rediscovered at runtime. (Legacy compileProfileQueryOptions keeps the old
    // discover-window-as-context behavior for old-server compatibility.)
    throw new Error(
      'Invalid v2 rules settings: active_time.always_active_pattern requires a configured window source; remove the pattern or re-add the window source'
    );
  }
  if (!capabilities.includes('query.categorize_v2.v1')) {
    throw new Error('Flexible categorization requires server capability query.categorize_v2.v1');
  }
  const categorySet = categorySets.find(candidate => candidate.id === profile.category_set_ids[0]);
  if (!categorySet) {
    throw new Error(`Category set ${profile.category_set_ids[0]} is unavailable`);
  }
  if (
    !profile.sources.some(source => source.builtin === 'window') &&
    categorySet.categories.some(
      category => category.rule.type !== 'none' && expressionUsesLegacyWindow(category.rule)
    )
  ) {
    throw new Error(
      'Invalid v2 rules settings: unsourced category rules require the App & window source'
    );
  }

  const category_specs = categorySet.categories.map(category => ({
    id: category.id,
    name: [...category.name],
    rule: rewriteUnsourcedToWindow(JSON.parse(JSON.stringify(category.rule)) as RuleExpressionV2),
    ...(category.priority !== undefined ? { priority: category.priority } : {}),
    requires: category.requires ? [...category.requires] : undefined,
  }));

  const categorySourceIds = new Set(
    category_specs.flatMap(category => [...collectRuleSourceIds(category.rule)])
  );
  const presentationSourceIds = new Set(
    [profile.app_title_source_id, profile.browser_focus_source_id].filter(
      (sourceId): sourceId is string => !!sourceId
    )
  );

  const activity_coverage_sources: CompiledCoverageSourceV2[] = [];
  const context_sources: CompiledContextSourceV2[] = [];
  for (const source of profile.sources) {
    if (source.builtin === 'window') {
      const location = {
        bucket_ids: [...source.bucket_ids],
        scope: source.bucket_ids.length === 0 ? ('host' as const) : source.scope,
        ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
        host: source.host,
      };
      if (source.creates_activity) {
        activity_coverage_sources.push({
          source_id: BUILTIN_WINDOW_SOURCE_ID,
          builtin: 'window',
          ...location,
          fields: [...source.fields],
          ...(source.keeps_active ? { keeps_active: true } : {}),
        });
      } else if (
        categorySourceIds.has(BUILTIN_WINDOW_SOURCE_ID) ||
        presentationSourceIds.has(BUILTIN_WINDOW_SOURCE_ID)
      ) {
        context_sources.push({
          source_id: BUILTIN_WINDOW_SOURCE_ID,
          builtin: 'window',
          ...location,
          fields: [...source.fields],
          conflict: 'base_wins',
        });
      }
      continue;
    }
    const location = {
      bucket_ids: [...source.bucket_ids],
      scope: source.bucket_ids.length === 0 && source.builtin ? ('host' as const) : source.scope,
      ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
      host: source.host,
      ...(source.builtin ? { builtin: source.builtin } : {}),
    };
    if (source.creates_activity) {
      activity_coverage_sources.push({
        source_id: source.id,
        ...location,
        fields: [...source.fields],
        ...(source.keeps_active ? { keeps_active: true } : {}),
      });
    } else if (categorySourceIds.has(source.id) || presentationSourceIds.has(source.id)) {
      context_sources.push({
        source_id: source.id,
        ...location,
        fields: [...source.fields],
        conflict: 'base_wins',
      });
    }
  }

  const needsNamespace = activity_coverage_sources.length > 0 || context_sources.length > 0;
  if (
    needsNamespace &&
    !capabilities.includes('query.merge_subwatcher_fields.source_namespace.v1')
  ) {
    throw new Error(
      'Namespaced source enrichment requires server capability ' +
        'query.merge_subwatcher_fields.source_namespace.v1'
    );
  }

  const result: CompiledActivityQueryV2 = {
    category_specs,
    context_sources,
    activity_coverage_sources,
    active_time_sources: [],
    app_title_source_id: profile.app_title_source_id,
    browser_focus_source_id: profile.browser_focus_source_id,
    capabilities: [...capabilities],
  };

  if (profile.active_time.type === 'expression') {
    if (!capabilities.includes('query.active_periods_v2.v1')) {
      throw new Error(
        'Active-time expressions require server capability query.active_periods_v2.v1'
      );
    }
    result.active_time_rule = JSON.parse(
      JSON.stringify(profile.active_time.rule)
    ) as RuleExpressionV2;
    const activeSourceIds = collectRuleSourceIds(result.active_time_rule);
    for (const source of profile.sources) {
      if (
        !activeSourceIds.has(source.builtin === 'window' ? BUILTIN_WINDOW_SOURCE_ID : source.id)
      ) {
        continue;
      }
      if (source.builtin === 'window') {
        result.active_time_sources.push({
          source_id: BUILTIN_WINDOW_SOURCE_ID,
          builtin: 'window',
          bucket_ids: [...source.bucket_ids],
          scope: source.bucket_ids.length === 0 ? 'host' : source.scope,
          ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
          host: source.host,
        });
      } else {
        result.active_time_sources.push({
          source_id: source.id,
          bucket_ids: [...source.bucket_ids],
          scope: source.bucket_ids.length === 0 && source.builtin ? 'host' : source.scope,
          ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
          host: source.host,
          ...(source.builtin ? { builtin: source.builtin } : {}),
        });
      }
    }
  } else {
    result.legacy_active_time = {
      use_afk: profile.active_time.use_afk,
      include_audible: profile.active_time.include_audible,
      always_active_pattern: profile.active_time.always_active_pattern,
    };
  }

  return result;
}

export function findCategoryRuleV2(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[],
  name: string[]
): CategoryRuleV2 | undefined {
  return findCategoryRuleLocationV2(profile, categorySets, name)?.category;
}

function findCategoryRuleLocationV2(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[],
  name: string[]
): { set: CategorySetV2; category: CategoryRuleV2 } | undefined {
  const set = categorySets[0];
  if (!set || profile.category_set_ids[0] !== set.id) return undefined;
  const category = set.categories.find(
    candidate => JSON.stringify(candidate.name) === JSON.stringify(name)
  );
  return category ? { set, category } : undefined;
}

function findCategoryRuleIdLocationV2(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[],
  id: string
): { set: CategorySetV2; category: CategoryRuleV2 } | undefined {
  const set = categorySets[0];
  if (!set || profile.category_set_ids[0] !== set.id) return undefined;
  const category = set.categories.find(candidate => candidate.id === id);
  return category ? { set, category } : undefined;
}

export function updateCategoryRuleV2(input: {
  profileId: string;
  profiles: ActivityProfileV2[];
  categorySets: CategorySetV2[];
  categoryId?: string;
  originalName: string[];
  name: string[];
  rule: RuleExpressionV2;
  priority: number;
  requires: string[];
}): { profiles: ActivityProfileV2[]; categorySets: CategorySetV2[] } {
  const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(input.profiles));
  const categorySets: CategorySetV2[] = JSON.parse(JSON.stringify(input.categorySets));
  const profile = profiles.find(candidate => candidate.id === input.profileId);
  if (!profile) throw new Error(`Activity profile ${input.profileId} was not found`);

  let matchLocation =
    (input.categoryId
      ? findCategoryRuleIdLocationV2(profile, categorySets, input.categoryId)
      : undefined) ?? findCategoryRuleLocationV2(profile, categorySets, input.originalName);
  if (!matchLocation) {
    const set = categorySets[0];
    if (set?.id !== profile.category_set_ids[0]) {
      throw new Error('The activity profile has no editable category set');
    }
    if (!set) throw new Error('The activity profile has no editable category set');
    const category: CategoryRuleV2 = {
      id: `manual:${input.name.map(encodeURIComponent).join('/')}`,
      name: [...input.name],
      rule: { type: 'none' },
    };
    set.categories.push(category);
    matchLocation = { set, category };
  }
  const { set, category } = matchLocation;
  category.name = [...input.name];
  category.rule = JSON.parse(JSON.stringify(input.rule));
  category.priority = input.priority;
  category.requires = [...input.requires];
  category.simple_ui = canUseSimpleCategoryUI(category);
  for (const candidate of set.categories) {
    if (
      candidate !== category &&
      candidate.name.length > input.originalName.length &&
      input.originalName.every((part, index) => candidate.name[index] === part)
    ) {
      candidate.name = [...input.name, ...candidate.name.slice(input.originalName.length)];
    }
  }
  return { profiles, categorySets };
}

export function synchronizeCategoryTreeV2(input: {
  profileId: string;
  profiles: ActivityProfileV2[];
  categorySets: CategorySetV2[];
  classes: Category[];
  replaceRules?: boolean;
}): { profiles: ActivityProfileV2[]; categorySets: CategorySetV2[] } {
  const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(input.profiles));
  const categorySets: CategorySetV2[] = JSON.parse(JSON.stringify(input.categorySets));
  const profile = profiles.find(candidate => candidate.id === input.profileId);
  const set = categorySets[0];
  if (!profile || !set || profile.category_set_ids[0] !== set.id) {
    throw new Error('The activity profile has no editable category set');
  }

  const names = new Set(input.classes.map(category => JSON.stringify(category.name)));
  set.categories = set.categories.filter(category => names.has(JSON.stringify(category.name)));
  for (const legacyCategory of input.classes) {
    let category = set.categories.find(
      candidate => JSON.stringify(candidate.name) === JSON.stringify(legacyCategory.name)
    );
    if (!category) {
      category = migrateCategorySet([legacyCategory], set.id).categories[0];
      set.categories.push(category);
    } else if (input.replaceRules || category.simple_ui === true) {
      category.rule = legacyRuleToV2(legacyCategory.rule as LegacyRule);
      category.priority = 0;
      category.requires = [];
      category.simple_ui = true;
    }
    if (legacyCategory.data) category.data = { ...legacyCategory.data };
    else delete category.data;
  }
  return { profiles, categorySets };
}

export function deleteCategoryRuleV2(input: {
  profileId: string;
  profiles: ActivityProfileV2[];
  categorySets: CategorySetV2[];
  categoryId?: string;
  name: string[];
}): { profiles: ActivityProfileV2[]; categorySets: CategorySetV2[] } {
  const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(input.profiles));
  const categorySets: CategorySetV2[] = JSON.parse(JSON.stringify(input.categorySets));
  const profile = profiles.find(candidate => candidate.id === input.profileId);
  if (!profile) throw new Error(`Activity profile ${input.profileId} was not found`);
  const matchLocation =
    (input.categoryId
      ? findCategoryRuleIdLocationV2(profile, categorySets, input.categoryId)
      : undefined) ?? findCategoryRuleLocationV2(profile, categorySets, input.name);
  if (matchLocation) {
    const dependents = matchLocation.set.categories.filter(category =>
      category.requires?.includes(matchLocation.category.id)
    );
    if (dependents.length > 0) {
      throw new Error(
        `Cannot delete ${matchLocation.category.name.join(' > ')} because it is required by ` +
          dependents.map(category => category.name.join(' > ')).join(', ')
      );
    }
    matchLocation.set.categories = matchLocation.set.categories.filter(
      category => category !== matchLocation.category
    );
  }
  return { profiles, categorySets };
}
