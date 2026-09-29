import type { Category } from '~/util/classes';
import {
  BUILTIN_WINDOW_SOURCE_ID,
  RULES_SCHEMA_VERSION,
  SOURCE_DEFAULTS_VERSION,
  defaultBuiltinSources,
  effectiveRuleSelector,
  isDefaultBuiltinSource,
  validateCategorySet,
  validateProfileRulesV2,
  type ActivityProfileV2,
  type CategoryRuleV2,
  type CategorySetV2,
  type NoneExpressionV2,
  type RegexExpressionV2,
  type RuleExpressionV2,
  type SourceDefinitionV2,
} from '~/util/rulesV2';

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
  category_sets: string[];
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
  const selector = effectiveRuleSelector(expression);
  if (selector.length > 0) legacy.select_keys = selector;
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

export function migrateLegacyCategorySets(
  legacySets: Array<{ id: string; categories: Category[] }>,
  requestedActiveIds: string[]
): { categorySets: CategorySetV2[]; activeSetIds: string[] } {
  const knownIds = new Set(legacySets.map(set => set.id));
  const activeSetIds = [...new Set(requestedActiveIds)].filter(id => knownIds.has(id));
  if (activeSetIds.length === 0) activeSetIds.push(legacySets[0].id);

  return {
    categorySets: legacySets.map(set => migrateCategorySet(set.categories, set.id)),
    activeSetIds,
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
  /** Canonical envelopes are already v2 and must not run predecessor source migrations. */
  authoritative?: boolean;
}): {
  activity_profiles_v2: ActivityProfileV2[];
  category_sets_v2: CategorySetV2[];
  migrated: boolean;
} {
  if (input.activity_profiles_v2 !== null || input.category_sets_v2 !== null) {
    if (!Array.isArray(input.activity_profiles_v2)) {
      throw new Error('activity_profiles_v2 must be an array');
    }
    if (!Array.isArray(input.category_sets_v2)) {
      throw new Error('category_sets_v2 must be an array');
    }
    if (input.activity_profiles_v2.length === 0) {
      throw new Error('activity_profiles_v2 must contain at least one profile');
    }
    if (input.category_sets_v2.length === 0) {
      throw new Error('category_sets_v2 must contain at least one category set');
    }
    const shapeErrors = input.authoritative
      ? [
          ...input.category_sets_v2.flatMap((set, index) => [
            ...validateCategorySet(set).map(error => `category_sets_v2[${index}].${error}`),
            ...(set &&
            typeof set === 'object' &&
            input.category_sets_v2?.slice(0, index).some(previous => previous?.id === set.id)
              ? [`category_sets_v2[${index}].id is duplicated`]
              : []),
          ]),
          ...input.activity_profiles_v2.flatMap((profile, index) =>
            validateProfileRulesV2(profile, input.category_sets_v2 as CategorySetV2[]).map(
              error => `activity_profiles_v2[${index}].${error}`
            )
          ),
        ]
      : [
          ...input.category_sets_v2.flatMap((set, index) =>
            !set || typeof set !== 'object' || !Array.isArray(set.categories)
              ? [`category_sets_v2[${index}].categories must be an array`]
              : []
          ),
          ...input.activity_profiles_v2.flatMap((profile, index) => {
            if (!profile || typeof profile !== 'object') {
              return [`activity_profiles_v2[${index}] must be an object`];
            }
            if (!Array.isArray(profile.category_set_ids)) {
              return [`activity_profiles_v2[${index}].category_set_ids must be an array`];
            }
            if (!Array.isArray(profile.sources)) {
              return [`activity_profiles_v2[${index}].sources must be an array`];
            }
            return [];
          }),
        ];
    if (shapeErrors.length > 0) {
      throw new Error(`Invalid v2 rules settings: ${shapeErrors.join('; ')}`);
    }
    if (input.authoritative) {
      // A validated canonical envelope is already normalized. Preserve profile,
      // set, and category definition order byte-for-byte (apart from cloning)
      // rather than moving the selected set to the front on every read/save.
      return {
        activity_profiles_v2: JSON.parse(JSON.stringify(input.activity_profiles_v2)),
        category_sets_v2: JSON.parse(JSON.stringify(input.category_sets_v2)),
        migrated: false,
      };
    }
  }
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
        ...(source.field_types ? { field_types: { ...source.field_types } } : {}),
        ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
      };
      if (input.authoritative) return normalized;

      // Only predecessor v2 documents use these compatibility migrations.
      // A revisioned canonical envelope is already the model: deprecated role
      // hints must not change its source membership or activity semantics.
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

export function selectedCategorySet(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[]
): CategorySetV2 | undefined {
  return profile.category_set_ids
    .map(id => categorySets.find(set => set.id === id))
    .find((set): set is CategorySetV2 => !!set);
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
    profile.category_set_ids.length !== 1 ||
    categorySet.categories.some(category => category.simple_ui !== true)
  ) {
    return 'advanced';
  }
  return 'simple';
}

export function expressionUsesLegacyWindow(expression: RuleExpressionV2): boolean {
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
    category_sets: profile.category_set_ids.slice(1),
  };
}

export function hasRulesSimplificationLosses(losses: RulesSimplificationLossSet): boolean {
  return (
    losses.categories.length > 0 ||
    losses.active_time !== null ||
    losses.sources.length > 0 ||
    losses.category_sets.length > 0
  );
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
