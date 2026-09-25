import Link from "next/link";

/** Cross-links between the `/internal` dashboards — the current page renders as plain text rather than a link. */
const PAGES = [
  { href: "/internal/analytics", label: "Engineering" },
  { href: "/internal/product-metrics", label: "Product" },
  { href: "/internal/users", label: "Users" },
] as const;

export function InternalNav({ current }: { current: (typeof PAGES)[number]["href"] }) {
  return (
    <nav className="flex gap-4 text-sm">
      {PAGES.map((p) =>
        p.href === current ? (
          <span key={p.href} className="font-medium text-navy-900">
            {p.label}
          </span>
        ) : (
          <Link key={p.href} href={p.href} className="text-teal-700 underline hover:text-teal-800">
            {p.label}
          </Link>
        ),
      )}
    </nav>
  );
}
