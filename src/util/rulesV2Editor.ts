import type { Category } from '~/util/classes';
import {
  canUseSimpleCategoryUI,
  legacyRuleToV2,
  migrateCategorySet,
  type ActivityProfileV2,
  type CategoryRuleV2,
  type CategorySetV2,
  type LegacyRule,
  type RuleExpressionV2,
} from '~/util/rulesV2';

export function findCategoryRuleV2(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[],
  name: string[],
  categorySetId?: string
): CategoryRuleV2 | undefined {
  return findCategoryRuleLocationV2(profile, categorySets, name, categorySetId)?.category;
}

function findCategoryRuleLocationV2(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[],
  name: string[],
  categorySetId = profile.category_set_ids[0]
): { set: CategorySetV2; category: CategoryRuleV2 } | undefined {
  const set = categorySets.find(candidate => candidate.id === categorySetId);
  if (!set) return undefined;
  const category = set.categories.find(
    candidate => JSON.stringify(candidate.name) === JSON.stringify(name)
  );
  return category ? { set, category } : undefined;
}

function findCategoryRuleIdLocationV2(
  profile: ActivityProfileV2,
  categorySets: CategorySetV2[],
  id: string,
  categorySetId = profile.category_set_ids[0]
): { set: CategorySetV2; category: CategoryRuleV2 } | undefined {
  const set = categorySets.find(candidate => candidate.id === categorySetId);
  if (!set) return undefined;
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
  categorySetId?: string;
}): { profiles: ActivityProfileV2[]; categorySets: CategorySetV2[] } {
  const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(input.profiles));
  const categorySets: CategorySetV2[] = JSON.parse(JSON.stringify(input.categorySets));
  const profile = profiles.find(candidate => candidate.id === input.profileId);
  if (!profile) throw new Error(`Activity profile ${input.profileId} was not found`);

  let matchLocation =
    (input.categoryId
      ? findCategoryRuleIdLocationV2(profile, categorySets, input.categoryId, input.categorySetId)
      : undefined) ??
    findCategoryRuleLocationV2(profile, categorySets, input.originalName, input.categorySetId);
  if (!matchLocation) {
    const set = categorySets.find(
      candidate => candidate.id === (input.categorySetId ?? profile.category_set_ids[0])
    );
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
  categorySetId?: string;
}): { profiles: ActivityProfileV2[]; categorySets: CategorySetV2[] } {
  const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(input.profiles));
  const categorySets: CategorySetV2[] = JSON.parse(JSON.stringify(input.categorySets));
  const profile = profiles.find(candidate => candidate.id === input.profileId);
  const set = profile
    ? categorySets.find(
        candidate => candidate.id === (input.categorySetId ?? profile.category_set_ids[0])
      )
    : undefined;
  if (!profile || !set) {
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
  categorySetId?: string;
}): { profiles: ActivityProfileV2[]; categorySets: CategorySetV2[] } {
  const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(input.profiles));
  const categorySets: CategorySetV2[] = JSON.parse(JSON.stringify(input.categorySets));
  const profile = profiles.find(candidate => candidate.id === input.profileId);
  if (!profile) throw new Error(`Activity profile ${input.profileId} was not found`);
  const matchLocation =
    (input.categoryId
      ? findCategoryRuleIdLocationV2(profile, categorySets, input.categoryId, input.categorySetId)
      : undefined) ??
    findCategoryRuleLocationV2(profile, categorySets, input.name, input.categorySetId);
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
