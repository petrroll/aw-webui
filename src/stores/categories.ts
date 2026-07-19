import _ from 'lodash';
import {
  cleanCategory,
  defaultCategories,
  build_category_hierarchy,
  createMissingParents,
  annotate,
  Category,
  Rule,
} from '~/util/classes';
import { getColorFromCategory } from '~/util/color';
import { defineStore } from 'pinia';
import { useSettingsStore } from '~/stores/settings';
import {
  deleteCategoryRuleV2,
  collectRuleSourceIds,
  synchronizeCategoryTreeV2,
  updateCategoryRuleV2,
  validateProfileRulesV2,
  mergeSourceDefinitionChanges,
  type RuleExpressionV2,
  type SourceDefinitionV2,
} from '~/util/rulesV2';

interface PendingV2Edit {
  categoryId?: string;
  originalName: string[];
  name: string[];
  rule: RuleExpressionV2;
  priority: number;
  requires: string[];
}

interface PendingV2Delete {
  delete: true;
  categoryId?: string;
  name: string[];
}

interface State {
  classes: Category[];
  classes_unsaved_changes: boolean;
  pending_v2_edits: Array<PendingV2Edit | PendingV2Delete>;
  pending_v2_sources: SourceDefinitionV2[] | null;
  _rules_v2_dirty_sections: string[];
  replace_v2_rules_on_save: boolean;
}

function getScoreFromCategory(c: Category, allCats: Category[]): number {
  // Returns the score for a certain category, falling back to parents if none set
  // Very similar to getColorFromCategory
  if (c && c.data && c.data.score) {
    return c.data.score;
  } else if (c && c.name.slice(0, -1).length > 0) {
    // If no color is set on category, traverse parents until one is found
    const parent = c.name.slice(0, -1);
    const parentCat = allCats.find(cc => _.isEqual(cc.name, parent));
    return getScoreFromCategory(parentCat, allCats);
  } else {
    return 0;
  }
}

// Normalize URL-encoded category segments (e.g. "Work%20Project" → "Work Project").
// Route query params can arrive encoded while category names are stored decoded.
function normalizeSegments(cat: string[]): string[] {
  return (cat || []).map(segment => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

function assignIds(classes: Category[]): Category[] {
  let i = 0;
  return classes.map(c => Object.assign(c, { id: i++ }));
}

export const useCategoryStore = defineStore('categories', {
  state: (): State => ({
    classes: [],
    classes_unsaved_changes: false,
    pending_v2_edits: [],
    pending_v2_sources: null,
    _rules_v2_dirty_sections: [],
    replace_v2_rules_on_save: false,
  }),

  // getters
  getters: {
    classes_clean(): Category[] {
      return this.classes.map(cleanCategory);
    },
    rules_v2_unsaved_changes(): boolean {
      return this._rules_v2_dirty_sections.length > 0;
    },
    classes_hierarchy() {
      const hier = build_category_hierarchy(_.cloneDeep(this.classes));
      return _.sortBy(hier, [c => c.id || 0]);
    },
    classes_for_query(): [string[], Rule][] {
      return this.classes
        .filter(c => c.rule.type !== null)
        .map(c => {
          return [c.name, c.rule];
        });
    },
    all_categories(): string[][] {
      // Returns a list of category names (a list of list of strings)
      return _.uniqBy(
        _.flatten(
          this.classes.map((c: Category) => {
            const l = [];
            for (let i = 1; i <= c.name.length; i++) {
              l.push(c.name.slice(0, i));
            }
            return l;
          })
        ),
        (v: string[]) => v.join('>>>>') // Can be any separator that doesn't appear in the category names themselves
      );
    },
    allCategoriesSelect(): { value: string[]; text: string }[] {
      const categories = this.all_categories;
      const entries = categories.map(c => {
        return { text: c.join(' > '), value: c, id: c.id };
      });
      return _.sortBy(entries, 'text');
    },
    get_category(this: State) {
      return (category_arr: string[]): Category => {
        if (typeof category_arr === 'string' || category_arr instanceof String)
          console.error('Passed category was string, expected array. Lookup will fail.');

        const match = this.classes.find(c => _.isEqual(c.name, category_arr));
        if (!match) {
          if (!_.isEqual(category_arr, ['Uncategorized']))
            console.error("Couldn't find category: ", category_arr);
          // fallback
          return { name: ['Uncategorized'], rule: { type: 'none' } };
        }
        return annotate(_.cloneDeep(match));
      };
    },
    get_category_by_id(this: State) {
      return (id: number) => {
        return annotate(_.cloneDeep(this.classes.find((c: Category) => c.id == id)));
      };
    },
    pendingV2Edit(this: State) {
      return (categoryId: string | undefined, name: string[]): PendingV2Edit | undefined => {
        const edit = this.pending_v2_edits.find(candidate => {
          if ('delete' in candidate) return false;
          return categoryId
            ? candidate.categoryId === categoryId
            : _.isEqual(candidate.name, name) || _.isEqual(candidate.originalName, name);
        });
        return edit && !('delete' in edit) ? _.cloneDeep(edit) : undefined;
      };
    },
    pendingV2Sources(this: State): SourceDefinitionV2[] | null {
      if (!this.pending_v2_sources) return null;
      const persisted = useSettingsStore().rulesV2.activity_profiles_v2[0]?.sources ?? [];
      return mergeSourceDefinitionChanges(persisted, this.pending_v2_sources, []);
    },
    canonicalNameForPendingPath(this: State) {
      return (name: string[]): string[] => {
        let canonicalName = [...name];
        const renames = this.pending_v2_edits
          .filter((candidate): candidate is PendingV2Edit => !('delete' in candidate))
          .filter(candidate => !_.isEqual(candidate.originalName, candidate.name))
          .sort((left, right) => right.name.length - left.name.length);
        for (let pass = 0; pass < renames.length; pass++) {
          let changed = false;
          for (const rename of renames) {
            if (
              canonicalName.length >= rename.name.length &&
              _.isEqual(canonicalName.slice(0, rename.name.length), rename.name)
            ) {
              canonicalName = rename.originalName.concat(canonicalName.slice(rename.name.length));
              changed = true;
            }
          }
          if (!changed) break;
        }
        return canonicalName;
      };
    },
    get_category_color() {
      return (cat: string[]): string => {
        return getColorFromCategory(this.get_category(normalizeSegments(cat)), this.classes);
      };
    },
    get_category_score() {
      return (cat: string[]): number => {
        return getScoreFromCategory(this.get_category(normalizeSegments(cat)), this.classes);
      };
    },
    category_select() {
      return (insertMeta: boolean): { text: string; value?: string[] }[] => {
        // Useful for <select> elements enumerating categories
        let cats = this.all_categories;
        cats = cats
          .map((c: string[]) => {
            return { text: c.join(' > '), value: c };
          })
          .sort((a, b) => a.text > b.text);
        if (insertMeta) {
          cats = [
            { text: 'All', value: null },
            { text: 'Uncategorized', value: ['Uncategorized'] },
          ].concat(cats);
        }
        return cats;
      };
    },
  },

  actions: {
    load(this: State, classes?: Category[]) {
      const loadedClasses = classes ?? useSettingsStore().classes;
      this.classes = assignIds(createMissingParents(loadedClasses));
      this.classes_unsaved_changes = false;
      this.pending_v2_edits = [];
      this.pending_v2_sources = null;
      this.replace_v2_rules_on_save = false;
    },

    async save(this: State, sourceSnapshot?: SourceDefinitionV2[]) {
      const settingsStore = useSettingsStore();
      if (process.env.NODE_ENV === 'test' && !settingsStore.loaded) {
        this.classes_unsaved_changes = false;
        this.pending_v2_edits = [];
        return;
      }
      await settingsStore.ensureLoaded();
      const rules = settingsStore.rulesV2;
      let profiles = rules.activity_profiles_v2;
      let categorySets = rules.category_sets_v2;
      if (sourceSnapshot) {
        profiles = _.cloneDeep(profiles);
        profiles[0].sources = _.cloneDeep(sourceSnapshot);
      }
      const profileId = profiles[0]?.id ?? 'default';
      for (const edit of this.pending_v2_edits) {
        const updated =
          'delete' in edit
            ? deleteCategoryRuleV2({
                profileId,
                profiles,
                categorySets,
                categoryId: edit.categoryId,
                name: edit.name,
              })
            : updateCategoryRuleV2({
                profileId,
                profiles,
                categorySets,
                ...edit,
              });
        profiles = updated.profiles;
        categorySets = updated.categorySets;
      }
      if (this.pending_v2_sources) {
        profiles = _.cloneDeep(profiles);
        profiles[0].sources = mergeSourceDefinitionChanges(
          profiles[0].sources,
          this.pending_v2_sources,
          []
        );
      }
      const synchronized = synchronizeCategoryTreeV2({
        profileId,
        profiles,
        categorySets,
        classes: this.classes.map(cleanCategory),
        replaceRules: this.replace_v2_rules_on_save,
      });
      const referencedSourceIds = new Set(
        synchronized.categorySets[0].categories.flatMap(category => [
          ...collectRuleSourceIds(category.rule),
        ])
      );
      if (synchronized.profiles[0].active_time.type === 'expression') {
        for (const sourceId of collectRuleSourceIds(synchronized.profiles[0].active_time.rule)) {
          referencedSourceIds.add(sourceId);
        }
      }
      synchronized.profiles[0].sources = synchronized.profiles[0].sources.filter(
        source => !source.auto_generated || referencedSourceIds.has(source.id)
      );
      const errors = synchronized.profiles.flatMap(profile =>
        validateProfileRulesV2(profile, synchronized.categorySets)
      );
      if (errors.length > 0) throw new Error(errors.join('\n'));
      await settingsStore.saveCanonicalRulesV2({
        profiles: synchronized.profiles,
        categorySets: synchronized.categorySets,
      });
      this.classes_unsaved_changes = false;
      this.pending_v2_edits = [];
      this.pending_v2_sources = null;
      this.replace_v2_rules_on_save = false;
    },
    discardPendingV2Changes(this: State) {
      this.pending_v2_edits = [];
      this.pending_v2_sources = null;
    },
    queueV2Sources(this: State, sources: SourceDefinitionV2[], baseline: SourceDefinitionV2[]) {
      const changed = mergeSourceDefinitionChanges([], sources, baseline);
      this.pending_v2_sources = mergeSourceDefinitionChanges(
        this.pending_v2_sources ?? [],
        changed,
        []
      );
      this.classes_unsaved_changes = true;
    },
    setRulesV2DraftDirty(this: State, section: string, dirty: boolean) {
      this._rules_v2_dirty_sections = dirty
        ? _.uniq([...this._rules_v2_dirty_sections, section])
        : this._rules_v2_dirty_sections.filter(candidate => candidate !== section);
    },
    queueV2Edit(this: State, edit: PendingV2Edit) {
      const index = this.pending_v2_edits.findIndex(candidate => {
        if ('delete' in candidate) return false;
        return edit.categoryId
          ? candidate.categoryId === edit.categoryId
          : _.isEqual(candidate.originalName, edit.originalName);
      });
      if (index >= 0) this.pending_v2_edits.splice(index, 1, _.cloneDeep(edit));
      else this.pending_v2_edits.push(_.cloneDeep(edit));
      this.classes_unsaved_changes = true;
    },
    queueV2Delete(this: State, name: string[], categoryId?: string) {
      this.pending_v2_edits = this.pending_v2_edits.filter(
        candidate =>
          !(
            'delete' in candidate &&
            (categoryId ? candidate.categoryId === categoryId : _.isEqual(candidate.name, name))
          )
      );
      this.pending_v2_edits.push({ delete: true, name: [...name], categoryId });
      this.classes_unsaved_changes = true;
    },

    // mutations
    import(this: State, classes: Category[]) {
      let i = 0;
      // overwrite id even if already set
      this.classes = classes.map(c => Object.assign(c, { id: i++ }));
      this.classes_unsaved_changes = true;
      this.replace_v2_rules_on_save = true;
    },
    updateClass(this: State, new_class: Category) {
      console.log('Updating class:', new_class);
      const old_class = this.classes.find((c: Category) => c.id === new_class.id);
      const old_name = old_class.name;
      const parent_depth = old_class.name.length;

      if (new_class.id === undefined || new_class.id === null) {
        new_class.id = (_.max(_.map(this.classes, 'id')) ?? -1) + 1;
        this.classes.push(new_class);
      } else {
        Object.assign(old_class, new_class);
      }

      // When a parent category is renamed, we also need to rename the children.
      // Only match categories strictly longer than old_name (actual children),
      // not siblings with the same name (fixes #702).
      _.map(this.classes, c => {
        if (
          c.id !== new_class.id &&
          c.name.length > parent_depth &&
          _.isEqual(old_name, c.name.slice(0, parent_depth))
        ) {
          c.name = new_class.name.concat(c.name.slice(parent_depth));
          console.log('Renamed child:', c.name);
        }
      });

      this.classes_unsaved_changes = true;
    },
    addClass(this: State, new_class: Category): number {
      new_class.id = (_.max(_.map(this.classes, 'id')) ?? -1) + 1;
      this.classes.push(new_class);
      this.classes_unsaved_changes = true;
      return new_class.id;
    },
    removeClass(this: State, classId: number) {
      this.classes = this.classes.filter((c: Category) => c.id !== classId);
      this.classes_unsaved_changes = true;
    },
    appendClassRule(this: State, classId: number, pattern: string) {
      const cat = this.classes.find((c: Category) => c.id === classId);
      if (cat.rule.type === 'none' || cat.rule.type === null) {
        cat.rule.type = 'regex';
        cat.rule.regex = pattern;
      } else if (cat.rule.type === 'regex') {
        cat.rule.regex += '|' + pattern;
      }
      this.classes_unsaved_changes = true;
    },
    restoreDefaultClasses(this: State) {
      this.classes = assignIds(createMissingParents(defaultCategories));
      this.classes_unsaved_changes = true;
      this.replace_v2_rules_on_save = true;
    },
    clearAll(this: State) {
      this.classes = [];
      this.classes_unsaved_changes = true;
      this.pending_v2_edits = [];
      this.pending_v2_sources = null;
      this._rules_v2_dirty_sections = [];
      this.replace_v2_rules_on_save = false;
    },
  },
});
