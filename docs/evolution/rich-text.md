# Rich text / markdown editing

v0.1 uses plain text input for messages. Future versions may support formatted text
via markdown or rich text editing:

**Minimal path** (`<textarea>` + markdown rendering):
- User types plain text or markdown syntax (e.g. `**bold**`, `_italic_`)
- Sent messages are rendered as markdown on display
- **Bundle**: ~12 kB (marked parser) + 0 (native textarea)
- **UX**: Like Reddit, Discord (original), GitHub comments
- Keyboard shortcuts (Ctrl+B/I/K) wrap selection with markdown syntax (~50 lines)

**WYSIWYG path** (Tiptap):
- Slack-like editor where formatting is visible as you type
- Markdown shortcuts auto-convert (`**bold**` → **bold**)
- **Bundle**: ~30-45 kB gzipped (headless, tree-shakeable)
- Headless architecture means full control over compact chat-input styling
- Built-in keyboard shortcuts (Ctrl+B/I/K)

**Source editing with highlighting** (CodeMirror 6):
- Raw markdown with syntax highlighting in the input field
- **Bundle**: ~40-50 kB gzipped (minimal markdown setup)
- Best for technical users comfortable with markdown syntax
- Requires custom work for keyboard shortcuts and compact input behavior

Decision deferred until v0.1 messaging is working and user feedback informs UX priorities.
