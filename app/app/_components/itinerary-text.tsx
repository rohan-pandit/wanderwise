import { parseMarkdownLite, type InlineSegment } from "@/src/domain/markdown-lite";

function renderInline(segments: InlineSegment[], keyPrefix: string) {
  return segments.map((segment, i) => {
    const key = `${keyPrefix}-${i}`;
    if (segment.type === "bold") return <strong key={key}>{segment.text}</strong>;
    if (segment.type === "italic") return <em key={key}>{segment.text}</em>;
    return segment.text;
  });
}

/**
 * Renders the Itinerary Writer agent's free-text output
 * (`src/domain/markdown-lite.ts` — a narrow Markdown subset, not a general
 * renderer). No hooks, no client-only behavior — used from both
 * `ItineraryPanel` ("use client") and the finalized trip review page (a
 * server component), so it stays its own plain component rather than living
 * inside either.
 */
export function ItineraryText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm text-navy-700">
      {parseMarkdownLite(text).map((block, i) => {
        const key = `md-${i}`;
        if (block.type === "heading") {
          const className = "font-serif font-semibold text-navy-900";
          if (block.level === 1) return <h3 key={key} className={`${className} text-base`}>{renderInline(block.inline, key)}</h3>;
          if (block.level === 2) return <h4 key={key} className={`${className} text-sm`}>{renderInline(block.inline, key)}</h4>;
          return <h5 key={key} className={`${className} text-sm`}>{renderInline(block.inline, key)}</h5>;
        }
        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={key} className={block.ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5"}>
              {block.items.map((item, j) => (
                <li key={`${key}-${j}`}>{renderInline(item, `${key}-${j}`)}</li>
              ))}
            </ListTag>
          );
        }
        return <p key={key}>{renderInline(block.inline, key)}</p>;
      })}
    </div>
  );
}
