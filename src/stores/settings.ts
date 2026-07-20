import { defineStore } from 'pinia';
import moment, { Moment } from 'moment';
import { getClient } from '~/util/awclient';
import { Category, defaultCategories, cleanCategory } from '~/util/classes';
import { SavedQuery } from '~/util/savedQueries';
import { View, defaultViews } from '~/stores/views';
import type { PrivacyFilterRule } from '~/util/privacyFilters';
import { isEqual } from 'lodash';
import { AppLocale, i18n, isAppLocale, setAppLocale } from '~/i18n';
import {
  compileProfileQueryOptions,
  compileActivityQueryV2,
  collectRuleSourceIds,
  applyRulesSimplification,
  categorySetToLegacyClasses,
  migrateCategorySet,
  migrateLegacySettings,
  resolveRulesV2Settings,
  inferRulesEditorMode,
  getLegacyWindowMode,
  deleteCategoryRuleV2,
  updateCategoryRuleV2,
  validateCategorySet,
  validateProfileRulesV2,
  type ActivityProfileV2,
  type CategorySetV2,
  type CompiledProfileQueryOptions,
  type CompiledActivityQueryV2,
  type RuleExpressionV2,
  type RulesEditorMode,
  type SourceDefinitionV2,
  mergeSourceDefinitionChanges,
} from '~/util/rulesV2';
import { useServerStore } from '~/stores/server';

function jsonEq(a: any, b: any) {
  const jsonA = JSON.parse(JSON.stringify(a));
  const jsonB = JSON.parse(JSON.stringify(b));
  return isEqual(jsonA, jsonB);
}

let settingsLoadPromise: Promise<void> | null = null;

// Backoffs for NewReleaseNotification
export const SHORT_BACKOFF_PERIOD = 24 * 60 * 60;
export const LONG_BACKOFF_PERIOD = 5 * 24 * 60 * 60;

// Initial wait period for UserSatisfactionPoll
export const INITIAL_WAIT_PERIOD = 7 * 24 * 60 * 60;

interface State {
  // Timestamp when user was first seen (first time webapp is run)
  initialTimestamp: Moment;

  startOfDay: string;
  startOfWeek: string;
  durationDefault: number;
  useColorFallback: boolean;
  landingpage: string;
  theme: 'light' | 'dark' | 'auto';
  locale: string;

  newReleaseCheckData: Record<string, any>;
  userSatisfactionPollData: {
    isEnabled: boolean;
    nextPollTime: Moment;
    timesPollIsShown: number;
  };
  uncategorizedNotificationData: {
    isEnabled: boolean;
    // Below this total tracked duration (seconds) the hint is hidden —
    // avoids nagging on quiet days.
    minTotalSeconds: number;
    // Hint shows when the uncategorized fraction crosses this ratio.
    minRatio: number;
  };
  always_active_pattern: string;
  privacy_filters: PrivacyFilterRule[];
  classes: Category[];
  activity_profiles_v2: ActivityProfileV2[] | null;
  category_sets_v2: CategorySetV2[] | null;
  rules_editor_mode: RulesEditorMode | null;
  views: View[];
  saved_queries: SavedQuery[];

  // Whether to show certain WIP features
  devmode: boolean;
  showYearly: boolean;
  useMultidevice: boolean;
  requestTimeout: number;

  // Set to true if settings loaded
  _loaded: boolean;
}

export const useSettingsStore = defineStore('settings', {
  state: (): State => ({
    initialTimestamp: moment(),

    startOfDay: '04:00',
    startOfWeek: 'Monday',
    durationDefault: 4 * 60 * 60,
    useColorFallback: false,
    landingpage: '/home',

    theme: 'auto',
    locale: 'en',

    newReleaseCheckData: {
      isEnabled: true,
      nextCheckTime: moment().add(SHORT_BACKOFF_PERIOD, 'seconds'),
      howOftenToCheck: SHORT_BACKOFF_PERIOD,
      timesChecked: 0,
    },
    userSatisfactionPollData: {
      isEnabled: true,
      nextPollTime: moment().add(INITIAL_WAIT_PERIOD, 'seconds'),
      timesPollIsShown: 0,
    },
    uncategorizedNotificationData: {
      isEnabled: true,
      minTotalSeconds: 60 * 60, // 1 hour
      minRatio: 0.3, // 30%
    },

    always_active_pattern: '',
    privacy_filters: [],
    classes: defaultCategories,
    activity_profiles_v2: null,
    category_sets_v2: null,
    rules_editor_mode: null,
    views: defaultViews,
    saved_queries: [],

    // Developer settings
    // NOTE: PRODUCTION might be undefined (in tests, for example)
    devmode: typeof PRODUCTION === 'undefined' ? true : !PRODUCTION,
    showYearly: false,
    useMultidevice: false,
    requestTimeout: 30,

    _loaded: false,
  }),

  getters: {
    loaded(state: State) {
      return state._loaded;
    },
    rulesV2(state: State): {
      activity_profiles_v2: ActivityProfileV2[];
      category_sets_v2: CategorySetV2[];
      migrated: boolean;
    } {
      return resolveRulesV2Settings({
        activity_profiles_v2: state.activity_profiles_v2,
        category_sets_v2: state.category_sets_v2,
        classes: state.classes,
        always_active_pattern: state.always_active_pattern,
      });
    },
    rulesEditorMode(): RulesEditorMode {
      const rules = this.rulesV2;
      return (
        this.rules_editor_mode ??
        inferRulesEditorMode(rules.activity_profiles_v2[0], rules.category_sets_v2[0])
      );
    },
    hasAdvancedRulesV2(): boolean {
      const rules = this.rulesV2;
      const profile = rules.activity_profiles_v2[0];
      const categorySet = rules.category_sets_v2[0];
      return (
        !!profile && !!categorySet && inferRulesEditorMode(profile, categorySet) === 'advanced'
      );
    },
    compiledRulesV2(): CompiledProfileQueryOptions | undefined {
      const rules = this.rulesV2;
      const profile = rules.activity_profiles_v2[0];
      const categorySet = rules.category_sets_v2[0];
      const capabilities = useServerStore().info?.capabilities ?? [];
      if (!profile || !categorySet || !capabilities.includes('query.categorize_v2.v1')) {
        return undefined;
      }
      const categorySourceIds = new Set(
        categorySet.categories.flatMap(category => [...collectRuleSourceIds(category.rule)])
      );
      if (
        profile.sources.some(
          source => !source.builtin && (categorySourceIds.has(source.id) || source.creates_activity)
        ) &&
        !capabilities.includes('query.merge_subwatcher_fields.source_namespace.v1')
      ) {
        return undefined;
      }
      if (
        getLegacyWindowMode(profile, categorySet) === 'context' &&
        !capabilities.includes('query.merge_subwatcher_fields.source_namespace.v1')
      ) {
        return undefined;
      }
      if (
        profile.active_time.type === 'expression' &&
        !capabilities.includes('query.active_periods_v2.v1')
      ) {
        return undefined;
      }
      return compileProfileQueryOptions(profile, rules.category_sets_v2, capabilities);
    },
    // v2-pure compiled options (window as an ordinary namespaced source, no
    // legacy_window_mode). Consumed via materializeActivityQueryV2 +
    // resolveActivityProfileV2. Additive to compiledRulesV2 while callers migrate.
    compiledActivityQueryV2(): CompiledActivityQueryV2 | undefined {
      const rules = this.rulesV2;
      const profile = rules.activity_profiles_v2[0];
      const categorySet = rules.category_sets_v2[0];
      const capabilities = useServerStore().info?.capabilities ?? [];
      if (!profile || !categorySet || !capabilities.includes('query.categorize_v2.v1')) {
        return undefined;
      }
      const usesNamespace =
        profile.sources.some(source => source.creates_activity || source.builtin === 'window') ||
        categorySet.categories.some(
          category => collectRuleSourceIds(category.rule).size > 0 || category.rule.type !== 'none'
        );
      if (
        usesNamespace &&
        !capabilities.includes('query.merge_subwatcher_fields.source_namespace.v1')
      ) {
        return undefined;
      }
      if (
        profile.active_time.type === 'expression' &&
        !capabilities.includes('query.active_periods_v2.v1')
      ) {
        return undefined;
      }
      return compileActivityQueryV2(profile, rules.category_sets_v2, capabilities);
    },
  },

  actions: {
    async ensureLoaded() {
      if (this.loaded) {
        return;
      }

      if (!settingsLoadPromise) {
        settingsLoadPromise = this.load().finally(() => {
          settingsLoadPromise = null;
        });
      }

      await settingsLoadPromise;
    },
    async load() {
      if (typeof localStorage === 'undefined') {
        console.error('localStorage is not supported');
        return;
      }
      const client = getClient();

      // Fetch from server, fall back to localStorage
      const server_settings = await client.get_settings();
      const legacyServerSettings = server_settings as Record<string, unknown>;

      // Build a unified map: server value wins, localStorage is fallback.
      // Skip keys that are missing from BOTH sources — otherwise `null` from
      // localStorage.getItem overrides the defaults defined in `state()`.
      const storage: Record<string, unknown> = {};
      const used = new Set<string>();
      const stateKeys = new Set(Object.keys(this.$state));

      // 1. Server settings take priority
      for (const key of Object.keys(server_settings)) {
        if (key.startsWith('_') || !stateKeys.has(key)) continue;
        if (key === 'locale' && !isAppLocale(server_settings[key])) {
          console.warn('Ignoring invalid locale from server:', server_settings[key]);
          continue;
        }
        storage[key] = server_settings[key];
        used.add(key);
      }

      // 2. localStorage fills in gaps, but skip missing keys (null)
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('_') || used.has(key) || !stateKeys.has(key)) continue;
        const raw = localStorage.getItem(key);
        if (raw === null || raw === 'null') continue; // key absent or stored as null → keep state() default

        // Keys ending with 'Data' are JSON-serialized objects in localStorage
        const isJsonKey =
          key.endsWith('Data') ||
          key == 'views' ||
          key == 'classes' ||
          key == 'activity_profiles_v2' ||
          key == 'category_sets_v2' ||
          key == 'saved_queries';
        try {
          if (isJsonKey) {
            let parsed = JSON.parse(raw);
            if (key == 'classes') {
              parsed = parsed.map(cleanCategory);
            }
            storage[key] = parsed;
          } else if (raw === 'true' || raw === 'false') {
            storage[key] = raw === 'true';
          } else if (key === 'locale') {
            if (isAppLocale(raw)) {
              storage[key] = raw;
            } else {
              console.warn('Ignoring invalid locale from storage:', raw);
            }
          } else {
            storage[key] = raw;
          }
        } catch (e) {
          console.error('failed to parse', key, raw, e);
        }
      }

      if (storage.category_sets_v2 == null && storage.activity_profiles_v2 == null) {
        const legacySetsRaw =
          legacyServerSettings.category_sets ??
          (() => {
            const raw = localStorage.getItem('category_sets');
            if (!raw || raw === 'null') return null;
            try {
              return JSON.parse(raw);
            } catch (error) {
              console.error('failed to parse category_sets', raw, error);
              return null;
            }
          })();
        const legacyActiveIdsRaw =
          legacyServerSettings.active_set_ids ??
          (() => {
            const raw = localStorage.getItem('active_set_ids');
            if (!raw || raw === 'null') return null;
            try {
              return JSON.parse(raw);
            } catch (error) {
              console.error('failed to parse active_set_ids', raw, error);
              return null;
            }
          })();
        if (Array.isArray(legacySetsRaw) && legacySetsRaw.length > 0) {
          const legacySets = legacySetsRaw
            .filter(
              set =>
                set &&
                typeof set.id === 'string' &&
                set.id.length > 0 &&
                Array.isArray(set.categories)
            )
            .map(set => ({
              id: set.id as string,
              categories: set.categories.map(cleanCategory),
            }));
          if (legacySets.length > 0) {
            const knownIds = new Set(legacySets.map(set => set.id));
            const activeIds = Array.isArray(legacyActiveIdsRaw)
              ? legacyActiveIdsRaw.filter(
                  (id): id is string => typeof id === 'string' && knownIds.has(id)
                )
              : [];
            const selectedIds = activeIds.length > 0 ? activeIds : [legacySets[0].id];
            const selectedSets = selectedIds
              .map(id => legacySets.find(set => set.id === id))
              .filter((set): set is (typeof legacySets)[number] => !!set);
            const seenCategories = new Set<string>();
            const mergedCategories = selectedSets.flatMap(set =>
              set.categories.filter(category => {
                const key = JSON.stringify(category.name);
                if (seenCategories.has(key)) return false;
                seenCategories.add(key);
                return true;
              })
            );
            const migrated = migrateLegacySettings({
              classes: (storage.classes as Category[] | undefined) ?? this.classes,
              always_active_pattern:
                (storage.always_active_pattern as string | undefined) ?? this.always_active_pattern,
            });
            storage.category_sets_v2 = [migrateCategorySet(mergedCategories)];
            storage.activity_profiles_v2 = [
              {
                ...migrated.activity_profiles_v2[0],
                category_set_ids: ['default'],
              },
            ];
          }
        }
      }
      this.$patch({ ...storage, _loaded: true });

      const resolvedRules = this.rulesV2;
      const canonicalProfile = resolvedRules.activity_profiles_v2[0];
      const canonicalSet = resolvedRules.category_sets_v2[0];
      const legacyClasses = categorySetToLegacyClasses(canonicalSet, this.classes);
      const legacyPattern =
        canonicalProfile.active_time.type === 'legacy'
          ? canonicalProfile.active_time.always_active_pattern
          : this.always_active_pattern;
      const canonicalSettings = {
        activity_profiles_v2: resolvedRules.activity_profiles_v2,
        category_sets_v2: resolvedRules.category_sets_v2,
        classes: legacyClasses,
        always_active_pattern: legacyPattern,
      };
      this.$patch(canonicalSettings);

      const localeFromServer = 'locale' in server_settings;
      const localeFromLocalStorage = localStorage.getItem('locale') != null;

      if ((localeFromServer || localeFromLocalStorage) && isAppLocale(this.locale)) {
        setAppLocale(this.locale);
      } else if (isAppLocale(i18n.locale)) {
        this.$patch({ locale: i18n.locale as AppLocale });
      }

      // Since `requestTimeout` is used to initialize the client, we need to set it again
      // https://github.com/ActivityWatch/activitywatch/issues/979
      client.req.defaults.timeout = this.requestTimeout * 1000;
    },
    async save() {
      // Important check, to avoid saving settings before they are loaded (potentially overwriting them with defaults)
      if (!this.loaded) {
        console.error('Settings not loaded, not saving');
        return;
      }
      // We want to avoid saving to localStorage to not accidentally mess up pre-migration data
      // For example, if the user is using several browsers, and opened in their non-main browser on first run after upgrade.
      const saveToLocalStorage = false;

      // Save to localStorage and backend
      // NOTE: localStorage deprecated, will be removed in future
      const client = getClient();

      // Fetch current settings from server
      const server_settings = await client.get_settings();

      // Save settings
      for (const key of Object.keys(this.$state)) {
        // Skip keys starting with underscore, as they are local to the vuex store.
        if (key.startsWith('_')) {
          continue;
        }

        const value = this.$state[key];
        if (
          value === null &&
          server_settings[key] === undefined &&
          (key === 'activity_profiles_v2' || key === 'category_sets_v2')
        ) {
          continue;
        }

        // Save to localStorage
        // NOTE: we always save the theme and landingpage to localStorage, since they are used before the settings are loaded
        if (saveToLocalStorage || key == 'theme' || key == 'landingpage') {
          if (typeof value === 'object') {
            localStorage.setItem(key, JSON.stringify(value));
          } else {
            localStorage.setItem(key, value);
          }
        }

        // Save changed settings to backend
        if (server_settings[key] === undefined || !jsonEq(server_settings[key], value)) {
          if (server_settings[key] === undefined && value === false) {
            // Skip saving settings that are set to false and not already saved on the server
            continue;
          }
          console.log('Saving', { [key]: value });
          //console.log('Was:', server_settings[key]);
          //console.log('Now:', value);
          await client.req.post('/0/settings/' + key, value, {
            headers: {
              'Content-Type': 'application/json',
            },
          });
        }
      }

      // After save, reload
      await this.load();
    },
    async update(new_state: Record<string, any>) {
      console.log('Updating state', new_state);
      await this.ensureLoaded();
      this.$patch(new_state);
      await this.save();
    },
    async saveCanonicalRulesV2(input: {
      profiles: ActivityProfileV2[];
      categorySets: CategorySetV2[];
      extra?: Record<string, unknown>;
    }) {
      const profile = input.profiles[0];
      const categorySet = input.categorySets.find(
        candidate => candidate.id === profile?.category_set_ids[0]
      );
      if (!profile || !categorySet) throw new Error('Canonical rules require one profile and set');
      const errors = validateProfileRulesV2(profile, input.categorySets);
      if (errors.length > 0) throw new Error(errors.join('\n'));
      const patch: Record<string, unknown> = {
        activity_profiles_v2: input.profiles,
        category_sets_v2: input.categorySets,
        classes: categorySetToLegacyClasses(categorySet, this.classes),
        ...input.extra,
      };
      if (profile.active_time.type === 'legacy') {
        patch.always_active_pattern = profile.active_time.always_active_pattern;
      }
      await this.update(patch);
      const legacyClasses = patch.classes;
      const client = getClient();
      await client.req.post(
        '/0/settings/category_sets',
        [{ id: 'default', categories: legacyClasses }],
        { headers: { 'Content-Type': 'application/json' } }
      );
      await client.req.post('/0/settings/active_set_ids', ['default'], {
        headers: { 'Content-Type': 'application/json' },
      });
      await this.load();
    },
    async setRulesEditorMode(mode: RulesEditorMode) {
      await this.update({ rules_editor_mode: mode });
    },
    async simplifyRulesV2() {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const simplified = applyRulesSimplification({
        profile: rules.activity_profiles_v2[0],
        categorySet: rules.category_sets_v2[0],
        always_active_pattern: this.always_active_pattern,
      });
      await this.update({
        ...simplified,
        rules_editor_mode: 'simple',
        always_active_pattern: this.always_active_pattern,
      });
    },
    async saveCategoryRuleV2(input: {
      categoryId?: string;
      originalName: string[];
      name: string[];
      rule: RuleExpressionV2;
      priority: number;
      requires: string[];
    }) {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const updated = updateCategoryRuleV2({
        profileId: rules.activity_profiles_v2[0]?.id ?? 'default',
        profiles: rules.activity_profiles_v2,
        categorySets: rules.category_sets_v2,
        ...input,
      });
      const errors = [
        ...updated.categorySets.flatMap(validateCategorySet),
        ...updated.profiles.flatMap(profile =>
          validateProfileRulesV2(profile, updated.categorySets)
        ),
      ];
      if (errors.length > 0) throw new Error(errors.join('\n'));
      await this.saveCanonicalRulesV2({
        profiles: updated.profiles,
        categorySets: updated.categorySets,
      });
    },
    async deleteCategoryRuleV2(name: string[], categoryId?: string) {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const updated = deleteCategoryRuleV2({
        profileId: rules.activity_profiles_v2[0]?.id ?? 'default',
        profiles: rules.activity_profiles_v2,
        categorySets: rules.category_sets_v2,
        categoryId,
        name,
      });
      const errors = updated.profiles.flatMap(profile =>
        validateProfileRulesV2(profile, updated.categorySets)
      );
      if (errors.length > 0) throw new Error(errors.join('\n'));
      await this.saveCanonicalRulesV2({
        profiles: updated.profiles,
        categorySets: updated.categorySets,
      });
    },
    async saveActiveTimeRuleV2(
      rule: RuleExpressionV2,
      sources?: SourceDefinitionV2[],
      baselineSources?: SourceDefinitionV2[]
    ) {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(rules.activity_profiles_v2));
      const profile = profiles[0];
      if (!profile) throw new Error('No activity profile is available');
      if (sources) {
        profile.sources = mergeSourceDefinitionChanges(
          profile.sources,
          sources,
          baselineSources ?? profile.sources
        );
      }
      profile.active_time = { type: 'expression', rule: JSON.parse(JSON.stringify(rule)) };
      const errors = validateProfileRulesV2(profile, rules.category_sets_v2);
      if (errors.length > 0) throw new Error(errors.join('\n'));
      await this.saveCanonicalRulesV2({
        profiles,
        categorySets: rules.category_sets_v2,
      });
    },
    async saveRuleSourcesV2(sources: SourceDefinitionV2[]) {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(rules.activity_profiles_v2));
      const profile = profiles[0];
      if (!profile) throw new Error('No activity profile is available');
      profile.sources = JSON.parse(JSON.stringify(sources));
      const errors = validateProfileRulesV2(profile, rules.category_sets_v2);
      if (errors.length > 0) throw new Error(errors.join('\n'));
      await this.saveCanonicalRulesV2({
        profiles,
        categorySets: rules.category_sets_v2,
      });
    },
    async saveLegacyActiveTimeV2(alwaysActivePattern = this.always_active_pattern) {
      await this.ensureLoaded();
      const rules = this.rulesV2;
      const profiles: ActivityProfileV2[] = JSON.parse(JSON.stringify(rules.activity_profiles_v2));
      const profile = profiles[0];
      if (!profile) throw new Error('No activity profile is available');
      const currentLegacy = profile.active_time.type === 'legacy' ? profile.active_time : undefined;
      profile.active_time = {
        type: 'legacy',
        use_afk: currentLegacy?.use_afk ?? true,
        include_audible: currentLegacy?.include_audible ?? true,
        always_active_pattern: alwaysActivePattern,
      };
      await this.saveCanonicalRulesV2({
        profiles,
        categorySets: rules.category_sets_v2,
        extra: { always_active_pattern: alwaysActivePattern },
      });
    },
    async useLegacyActiveTimeV2() {
      await this.saveLegacyActiveTimeV2();
    },
  },
});
