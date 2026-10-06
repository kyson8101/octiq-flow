// Same grants as the backend's HTML_FILE_CSP. Never add allow-same-origin: a
// srcdoc frame would then share this page's origin, token and localStorage.
export const HTML_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
