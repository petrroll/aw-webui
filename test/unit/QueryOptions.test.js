import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import Vue from 'vue';
import { BootstrapVue } from 'bootstrap-vue';

import QueryOptions from '~/components/QueryOptions.vue';
import { useBucketsStore } from '~/stores/buckets';

Vue.use(BootstrapVue);

describe('QueryOptions', () => {
  test('toggles AFK filtering when its visible label is clicked', async () => {
    setActivePinia(createPinia());
    const bucketsStore = useBucketsStore();
    bucketsStore.ensureLoaded = jest.fn().mockResolvedValue(undefined);
    bucketsStore.buckets = [
      {
        id: 'window',
        hostname: 'desktop',
        type: 'currentwindow',
        data: {},
      },
    ];

    const wrapper = mount(QueryOptions, { attachTo: document.body });
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    const checkbox = wrapper.find('input[type="checkbox"]');
    expect(checkbox.element.checked).toBe(true);

    await wrapper.find('.custom-control-label').trigger('click');
    expect(checkbox.element.checked).toBe(false);
    expect(wrapper.emitted('input').at(-1)[0].filter_afk).toBe(false);

    wrapper.destroy();
  });
});
