// Terminal management moved to terminals.js (the shared terminal-tab
// primitive) and project.js (Project-mode integration). main.js no longer
// boots a "main" terminal — at startup no project is selected, so no terminal
// is spawned. Terminals are created per project on selection (project.js) and
// per chat/utility run by their own modules. The single pty-output listener
// now lives in terminals.js.
//
// This file is intentionally empty. Kept so index.html's <script src="/main.js">
// stays valid; remove the file and its <script> tag together if desired later.
