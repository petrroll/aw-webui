<template lang="pug">
b-alert(:show="formattedErrors.length > 0" variant="danger")
  p.mb-1 {{ $t('settings.categorization.validationReview') }}
  ul.mb-0.pl-3
    li(v-for="error in formattedErrors" :key="error") {{ error }}
</template>

<script lang="ts">
import type { SourceDefinitionV2 } from '~/util/rulesV2';
import { formatRulesValidationError } from '~/util/rulesEditor';

export default {
  name: 'RulesValidationAlert',
  props: {
    errors: { type: Array, default: () => [] },
    sources: { type: Array, default: () => [] },
  },
  computed: {
    formattedErrors(): string[] {
      return [
        ...new Set(
          (this.errors as string[]).map(error =>
            formatRulesValidationError(error, this.sources as SourceDefinitionV2[], (key, values) =>
              String(this.$t(key, values))
            )
          )
        ),
      ];
    },
  },
};
</script>
