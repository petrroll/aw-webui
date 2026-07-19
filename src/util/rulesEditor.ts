import type { CategoryRuleV2, RuleExpressionV2, SourceDefinitionV2 } from '~/util/rulesV2';
import type { IBucket } from '~/util/interfaces';

export function resolveBucketOwnership(
  bucketIds: string[],
  buckets: IBucket[]
): { bucketHosts: Record<string, string>; unresolved: string[] } {
  const bucketsById = new Map(buckets.map(bucket => [bucket.id, bucket]));
  const bucketHosts: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const bucketId of bucketIds) {
    const host = bucketsById.get(bucketId)?.hostname;
    if (host && host !== 'unknown') bucketHosts[bucketId] = host;
    else unresolved.push(bucketId);
  }
  return { bucketHosts, unresolved };
}

export function convertRuleExpressionType(
  expression: RuleExpressionV2,
  type: RuleExpressionV2['type']
): RuleExpressionV2 {
  if (type === 'all' || type === 'any') {
    const rules =
      expression.type === 'all' || expression.type === 'any'
        ? [...expression.rules]
        : expression.type === 'none'
        ? [{ type: 'none' as const }]
        : [JSON.parse(JSON.stringify(expression))];
    return { type, rules };
  }
  if (type === 'regex') {
    const firstRegex =
      expression.type === 'all' || expression.type === 'any'
        ? expression.rules.find(rule => rule.type === 'regex')
        : null;
    return firstRegex
      ? JSON.parse(JSON.stringify(firstRegex))
      : { type: 'regex', regex: '', weight: 0 };
  }
  return { type: 'none' };
}

export function resetRegexToAutomatic(expression: RuleExpressionV2): RuleExpressionV2 {
  if (expression.type !== 'regex') return expression;
  const automatic = { ...expression };
  delete automatic.source;
  delete automatic.field;
  delete automatic.fields;
  delete automatic.host;
  delete automatic.negate;
  delete automatic.weight;
  delete automatic.value_mode;
  return automatic;
}

export interface ParentRequirementOption {
  value: string;
  text: string;
  missingRule: boolean;
  disabled: boolean;
}

export function buildParentRequirementOptions(input: {
  categories: CategoryRuleV2[];
  currentPath: string[];
  currentCategoryId?: string;
  selectedIds: string[];
  pendingEdit: (category: CategoryRuleV2) => Pick<CategoryRuleV2, 'name' | 'rule'> | undefined;
}): ParentRequirementOption[] {
  return input.categories
    .map(category => {
      const pendingEdit = input.pendingEdit(category);
      return {
        category,
        effectiveName: pendingEdit?.name ?? category.name,
        effectiveRule: pendingEdit?.rule ?? category.rule,
      };
    })
    .filter(
      ({ category, effectiveName }) =>
        category.id !== input.currentCategoryId &&
        effectiveName.length < input.currentPath.length &&
        effectiveName.every((part, index) => part === input.currentPath[index])
    )
    .map(({ category, effectiveName, effectiveRule }) => {
      const missingRule = effectiveRule.type === 'none';
      const selected = input.selectedIds.includes(category.id);
      return {
        value: category.id,
        text: effectiveName.join(' > '),
        missingRule,
        disabled: missingRule && !selected,
      };
    });
}

export function createDefaultRuleSource(existingIds: string[]): SourceDefinitionV2 {
  let suffix = existingIds.length + 1;
  while (existingIds.includes(`source-${suffix}`)) suffix++;
  return {
    id: `source-${suffix}`,
    label: `Source ${suffix}`,
    bucket_ids: [],
    scope: 'host',
    bucket_hosts: {},
    fields: ['app', 'title'],
  };
}

export function formatRulesValidationError(
  error: string,
  sources: SourceDefinitionV2[],
  translate: (key: string, values?: Record<string, unknown>) => string
): string {
  const sourceMatch = error.match(/^sources\[(\d+)\](.*)$/);
  if (sourceMatch) {
    const source = sources[Number(sourceMatch[1])];
    const label = source?.label || source?.id || `#${Number(sourceMatch[1]) + 1}`;
    const detail = sourceMatch[2];
    if (detail.includes('.bucket_ids must be non-empty')) {
      return translate('settings.categorization.validationSourceBucketsRequired', {
        source: label,
      });
    }
    if (detail.includes('.fields must be non-empty')) {
      return translate('settings.categorization.validationSourceFieldsRequired', { source: label });
    }
    if (detail.includes('.bucket_ids must be unique')) {
      return translate('settings.categorization.validationSourceBucketsUnique', { source: label });
    }
    if (detail.includes('.id is invalid') || detail.includes('.id is duplicated')) {
      return translate('settings.categorization.validationSourceId', { source: label });
    }
    if (
      detail.includes('scope') ||
      detail.includes('ownership') ||
      detail.includes('bucket_hosts')
    ) {
      return translate('settings.categorization.validationSourceOwnership', { source: label });
    }
  }

  const unknownSource = error.match(/references unknown source (.+)$/);
  if (unknownSource) {
    return translate('settings.categorization.ruleUnknownSource', { source: unknownSource[1] });
  }
  if (error.includes('.regex must be non-empty')) {
    return translate('settings.categorization.validationPatternRequired');
  }
  if (error.includes('.regex is invalid')) {
    return translate('settings.categorization.validationPatternInvalid');
  }
  if (error.includes('.regex exceeds maximum length')) {
    return translate('settings.categorization.validationPatternTooLong');
  }
  if (
    error.includes('.weight must be an integer') ||
    error.includes('.priority must be an integer')
  ) {
    return translate('settings.categorization.validationWholeNumber');
  }
  if (error.includes('.rules must contain at least one rule')) {
    return translate('settings.categorization.validationGroupRequired');
  }
  if (
    error.includes('active_time.rule.source must be non-empty') ||
    error.includes('active_time.rule must contain at least one matching condition')
  ) {
    return translate('settings.categorization.validationActiveTimeSource');
  }
  return translate('settings.categorization.validationGeneric', { error });
}
