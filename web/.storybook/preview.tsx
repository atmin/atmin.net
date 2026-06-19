import { withThemeByClassName } from '@storybook/addon-themes';
import type { Preview } from '@storybook/react-vite';
import { App as KonstaApp } from 'konsta/react';
import { MemoryRouter } from 'react-router-dom';
import '../src/index.css';

// ADR-0023 — the Konsta harness every later migration task's stories depend on:
// an ios/material toolbar global feeding Konsta's <App theme>, composed with the
// existing light/dark class toggle. Verify a Konsta component in all four
// combinations (ios/material × light/dark) via the two toolbars.
const preview: Preview = {
    globalTypes: {
        konstaTheme: {
            description: 'Konsta platform theme',
            toolbar: {
                title: 'Konsta',
                icon: 'mobile',
                items: [
                    { value: 'ios', title: 'iOS' },
                    { value: 'material', title: 'Material' },
                ],
                dynamicTitle: true,
            },
        },
    },
    initialGlobals: {
        konstaTheme: 'ios',
    },
    decorators: [
        // Konsta provider — supplies the k-ios/k-material theme context that
        // every Konsta component reads. `dark` composes with the .dark class
        // toggled by withThemeByClassName below.
        (Story, context) => (
            <KonstaApp theme={context.globals.konstaTheme} dark safeAreas>
                <Story />
            </KonstaApp>
        ),
        (Story) => (
            <MemoryRouter>
                <Story />
            </MemoryRouter>
        ),
        withThemeByClassName({
            themes: {
                light: '',
                dark: 'dark',
            },
            defaultTheme: 'light',
        }),
    ],
    parameters: {
        controls: {
            matchers: {
                color: /(background|color)$/i,
                date: /Date$/i,
            },
        },
        a11y: {
            test: 'todo',
        },
    },
};

export default preview;
