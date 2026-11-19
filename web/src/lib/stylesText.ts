// Test-only: the full text of the app's base stylesheet. `styles.css` is a
// manifest of `@import`s into `styles/`; the tests read the parts joined in
// manifest order with nothing added, which is the old single file byte for byte.
import manifest from "../styles.css?raw";

const parts = import.meta.glob("../styles/*.css", { query: "?raw", eager: true, import: "default" }) as Record<string, string>;

const order = [...manifest.matchAll(/@import\s+"\.\/styles\/([^"]+)";/g)].map((m) => m[1]);
if (order.length === 0) throw new Error("styles.css lists no parts");

const styles = order
  .map((name) => {
    const text = parts[`../styles/${name}`];
    if (text === undefined) throw new Error(`styles.css imports ${name}, which is not in styles/`);
    return text;
  })
  .join("");

export default styles;
