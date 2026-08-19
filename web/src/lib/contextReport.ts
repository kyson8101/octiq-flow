// Reading `/context` back into something worth looking at.
//
// The command answers with markdown: a total, a table of categories, and a
// table of every MCP tool with its cost. All of it is true and none of it is
// scannable — the question you asked was "what is eating my context", and the
// answer is forty rows of numbers you have to add up yourself.
//
// The shape is regular enough to parse, so it becomes a bar you can look at
// once. Nothing here invents or estimates: every number below is lifted from
// the reply, and anything that does not parse falls back to the markdown,
// because a wrong chart is worse than an honest table.
export type ContextSlice = {
  label: string;
  tokens: number;
  /** Percent of the whole window, as the report states it. */
  percent: number;
};

export type ContextReport = {
  model?: string;
  usedTokens?: number;
  totalTokens?: number;
  usedPercent?: number;
  categories: ContextSlice[];
  /** One row per MCP tool. Often forty of them, hence the fold. */
  tools: { name: string; server: string; tokens: number }[];
};

/** "1.1k" / "37k" / "895" / "166.7k" → a number. */
function tokens(text: string): number {
  const clean = text.trim().replace(/,/g, "");
  const match = /^([\d.]+)\s*([km]?)$/i.exec(clean);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const scale = match[2].toLowerCase();
  return Math.round(value * (scale === "m" ? 1e6 : scale === "k" ? 1e3 : 1));
}

/** Cells of a markdown table row, without the outer pipes. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

const SEPARATOR = /^\|?[\s:-]+\|[\s|:-]*$/;

/** True when a reply looks like the answer to `/context`. */
export function isContextReport(text: string): boolean {
  return /^#{1,3}\s*Context Usage/im.test(text);
}

/** Parse one. Returns null when it is not the shape we know, so the caller can
 *  show the markdown it already had. */
export function parseContextReport(text: string): ContextReport | null {
  if (!isContextReport(text)) return null;

  const report: ContextReport = { categories: [], tools: [] };

  report.model = /\*\*Model:\*\*\s*([^\s*]+)/i.exec(text)?.[1];

  // **Tokens:** 33.3k / 200k (17%)
  const totals = /\*\*Tokens:\*\*\s*([\d.,]+\s*[km]?)\s*\/\s*([\d.,]+\s*[km]?)\s*\((\d+(?:\.\d+)?)%\)/i.exec(text);
  if (totals) {
    report.usedTokens = tokens(totals[1]);
    report.totalTokens = tokens(totals[2]);
    report.usedPercent = Number(totals[3]);
  }

  // Two tables, told apart by their headers rather than their order.
  let table: "categories" | "tools" | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      // A heading or blank line ends whichever table we were in.
      if (trimmed) table = null;
      continue;
    }
    if (SEPARATOR.test(trimmed)) continue;

    const row = cells(trimmed);
    const head = row[0]?.toLowerCase();

    if (head === "category") {
      table = "categories";
      continue;
    }
    if (head === "tool") {
      table = "tools";
      continue;
    }

    if (table === "categories" && row.length >= 2) {
      report.categories.push({
        label: row[0],
        tokens: tokens(row[1]),
        percent: Number(row[2]?.replace("%", "")) || 0,
      });
    } else if (table === "tools" && row.length >= 3) {
      report.tools.push({ name: row[0], server: row[1], tokens: tokens(row[2]) });
    }
  }

  // A report with no categories is not one we can draw better than markdown.
  return report.categories.length ? report : null;
}

/** The MCP tools' cost per server, biggest first.
 *
 *  The per-tool table is where the tokens actually are — forty rows of a few
 *  hundred each — but the decision it informs is "which server do I turn off",
 *  and that is per server. */
export function byServer(report: ContextReport): { server: string; tokens: number; count: number }[] {
  const totals = new Map<string, { tokens: number; count: number }>();
  for (const tool of report.tools) {
    const entry = totals.get(tool.server) ?? { tokens: 0, count: 0 };
    entry.tokens += tool.tokens;
    entry.count += 1;
    totals.set(tool.server, entry);
  }
  return [...totals.entries()]
    .map(([server, v]) => ({ server, ...v }))
    .sort((a, b) => b.tokens - a.tokens);
}
