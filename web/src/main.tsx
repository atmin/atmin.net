import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/routes/app';
import './index.css';

// Sync dark class with system preference changes
const mq = window.matchMedia('(prefers-color-scheme: dark)');
mq.addEventListener('change', (e) => {
    document.documentElement.classList.toggle('dark', e.matches);
});

// biome-ignore lint/style/noNonNullAssertion: root element always present in index.html
createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
