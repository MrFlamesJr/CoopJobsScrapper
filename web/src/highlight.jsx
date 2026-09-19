import { createContext, useContext, useMemo } from "react";

// Lowercase search words currently highlighted; empty means highlighting is
// off (or there's no query). Provided by App, read by any component that
// wraps user-visible text in <Highlight>.
export const HighlightContext = createContext([]);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Renders `text` plain, or with every occurrence of a current highlight word
 * wrapped in <mark className="hl">. One escaped, case-insensitive regex for
 * all words at once, memoised so re-renders that don't change the text or
 * the word list don't re-split it.
 */
export function Highlight({ text }) {
  const words = useContext(HighlightContext);
  return useMemo(() => {
    const str = text == null ? "" : String(text);
    if (!str || words.length === 0) return str;

    const pattern = words.map(escapeRegExp).join("|");
    const re = new RegExp(`(${pattern})`, "gi");
    const parts = str.split(re);
    if (parts.length === 1) return str;

    // A single capturing group makes `split` alternate non-match, match,
    // non-match, … — odd indices are always the matched words.
    return parts.map((part, i) =>
      i % 2 === 1 ? (
        <mark key={i} className="hl">
          {part}
        </mark>
      ) : (
        part
      ),
    );
  }, [text, words]);
}
