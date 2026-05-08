import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  "stories": [
    "../src/**/*.mdx",
    "../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"
  ],
  "addons": [
    "@chromatic-com/storybook",
    "@storybook/addon-vitest",
    "@storybook/addon-a11y",
    "@storybook/addon-docs",
    "@storybook/addon-onboarding",
    "@storybook/addon-themes"
  ],
  "framework": "@storybook/react-vite",
  viteFinal: async (config) => ({
    ...config,
    plugins: (config.plugins ?? []).flat().filter(
      (p) => !(p && 'name' in p && typeof p.name === 'string' && p.name.startsWith('vite-plugin-pwa'))
    ),
  }),
};
export default config;