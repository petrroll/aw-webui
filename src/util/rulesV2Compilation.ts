import {
  BUILTIN_WINDOW_SOURCE_ID,
  collectRuleSourceIds,
  defaultBuiltinWindowSource,
  effectiveRuleSelector,
  getLegacyWindowMode,
  sourceIntervalPolicy,
  validateProfileRulesV2,
  type ActivityProfileV2,
  type CategorySetV2,
  type CompiledActivityQueryV2,
  type CompiledContextSourceV2,
  type CompiledCoverageSourceV2,
  type CompiledProfileQueryOptions,
  type RegexExpressionV2,
  type RuleExpressionV2,
} from '~/util/rulesV2';

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
    rule: semanticRuleExpression(category.rule),
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

export function semanticRuleExpression(expression: RuleExpressionV2): RuleExpressionV2 {
  if (expression.type === 'none') return { type: 'none' };
  if (expression.type === 'all' || expression.type === 'any') {
    return {
      type: expression.type,
      rules: expression.rules.map(semanticRuleExpression),
    };
  }
  const predicate = expression as RegexExpressionV2;
  const selector = effectiveRuleSelector(predicate);
  return {
    type: 'regex',
    regex: predicate.regex,
    ...(predicate.source !== undefined ? { source: predicate.source } : {}),
    ...(predicate.host !== undefined ? { host: predicate.host } : {}),
    ...(predicate.fields !== undefined
      ? { fields: selector }
      : predicate.field !== undefined
      ? { field: selector[0] }
      : selector.length === 1
      ? { field: selector[0] }
      : selector.length > 1
      ? { fields: selector }
      : {}),
    ...(predicate.ignore_case !== undefined ? { ignore_case: predicate.ignore_case } : {}),
    ...(predicate.negate !== undefined ? { negate: predicate.negate } : {}),
    ...(predicate.value_mode !== undefined ? { value_mode: predicate.value_mode } : {}),
    ...(predicate.weight !== undefined ? { weight: predicate.weight } : {}),
  };
}

export function compiledCategoryId(setId: string, categoryId: string): string {
  const byteLength = new TextEncoder().encode(setId).length;
  return `set:${byteLength}:${setId}:rule:${categoryId}`;
}

function selectedCategorySets(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[]
): CategorySetV2[] {
  return profile.category_set_ids.map(id => {
    const set = categorySets.find(candidate => candidate.id === id);
    if (!set) throw new Error(`Category set ${id} is unavailable`);
    return set;
  });
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

/** Compile a profile into the current source-only query representation. */
export function compileActivityQueryV2(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[],
  capabilities: string[]
): CompiledActivityQueryV2 {
  const errors = validateProfileRulesV2(profile, categorySets);
  if (errors.length > 0) {
    throw new Error(`Invalid v2 rules settings: ${errors.join('; ')}`);
  }
  if (!capabilities.includes('query.categorize_v2.v1')) {
    throw new Error('Flexible categorization requires server capability query.categorize_v2.v1');
  }
  const selectedSets = selectedCategorySets(profile, categorySets);
  const category_specs = selectedSets.flatMap((set, setIndex) =>
    set.categories.map(category => ({
      id: compiledCategoryId(set.id, category.id),
      name: [...category.name],
      rule: rewriteUnsourcedToWindow(semanticRuleExpression(category.rule)),
      ...(category.priority !== undefined ? { priority: category.priority } : {}),
      set_priority: set.priority ?? selectedSets.length - setIndex,
      requires: category.requires?.map(requirement => compiledCategoryId(set.id, requirement)),
    }))
  );

  const activity_coverage_sources: CompiledCoverageSourceV2[] = [];
  const context_sources: CompiledContextSourceV2[] = [];
  for (const source of profile.sources) {
    if (source.builtin === 'window') {
      const sourceLocation = {
        bucket_ids: [...source.bucket_ids],
        scope: source.bucket_ids.length === 0 ? ('host' as const) : source.scope,
        ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
        host: source.host,
      };
      if (source.creates_activity) {
        activity_coverage_sources.push({
          source_id: BUILTIN_WINDOW_SOURCE_ID,
          builtin: 'window',
          ...sourceLocation,
          fields: [...source.fields],
          interval_policy: sourceIntervalPolicy(source),
          ...(source.keeps_active ? { keeps_active: true } : {}),
        });
      } else {
        context_sources.push({
          source_id: BUILTIN_WINDOW_SOURCE_ID,
          builtin: 'window',
          ...sourceLocation,
          fields: [...source.fields],
          interval_policy: sourceIntervalPolicy(source),
          conflict: 'base_wins',
        });
      }
      continue;
    }
    const sourceLocation = {
      bucket_ids: [...source.bucket_ids],
      scope: source.bucket_ids.length === 0 && source.builtin ? ('host' as const) : source.scope,
      ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
      host: source.host,
      ...(source.builtin ? { builtin: source.builtin } : {}),
    };
    if (source.creates_activity) {
      activity_coverage_sources.push({
        source_id: source.id,
        ...sourceLocation,
        fields: [...source.fields],
        interval_policy: sourceIntervalPolicy(source),
        ...(source.keeps_active ? { keeps_active: true } : {}),
      });
    } else {
      context_sources.push({
        source_id: source.id,
        ...sourceLocation,
        fields: [...source.fields],
        interval_policy: sourceIntervalPolicy(source),
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

  const configuredBrowserSource = profile.sources.find(source => source.builtin === 'browser');
  const result: CompiledActivityQueryV2 = {
    declared_source_ids: profile.sources.map(source => source.id),
    category_specs,
    context_sources,
    activity_coverage_sources,
    active_time_sources: [],
    app_title_source_id: profile.app_title_source_id,
    browser_focus_source_id: profile.browser_focus_source_id,
    ...(configuredBrowserSource
      ? {
          browser_source: {
            source_id: configuredBrowserSource.id,
            builtin: 'browser',
            bucket_ids: [...configuredBrowserSource.bucket_ids],
            scope:
              configuredBrowserSource.bucket_ids.length === 0
                ? 'host'
                : configuredBrowserSource.scope,
            ...(configuredBrowserSource.bucket_hosts
              ? { bucket_hosts: { ...configuredBrowserSource.bucket_hosts } }
              : {}),
            fields: [...configuredBrowserSource.fields],
            interval_policy: sourceIntervalPolicy(configuredBrowserSource),
            host: configuredBrowserSource.host,
          },
        }
      : {}),
    capabilities: [...capabilities],
  };

  if (profile.active_time.type === 'expression') {
    if (!capabilities.includes('query.active_periods_v2.v1')) {
      throw new Error(
        'Active-time expressions require server capability query.active_periods_v2.v1'
      );
    }
    result.active_time_rule = semanticRuleExpression(profile.active_time.rule);
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
          interval_policy: sourceIntervalPolicy(source),
          scope: source.bucket_ids.length === 0 ? 'host' : source.scope,
          ...(source.bucket_hosts ? { bucket_hosts: { ...source.bucket_hosts } } : {}),
          host: source.host,
        });
      } else {
        result.active_time_sources.push({
          source_id: source.id,
          bucket_ids: [...source.bucket_ids],
          interval_policy: sourceIntervalPolicy(source),
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
