export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) return null;

  const pages = new Set<number>();
  for (let p = Math.max(1, page - 2); p <= Math.min(pageCount, page + 2); p++) pages.add(p);
  pages.add(1);
  pages.add(pageCount);
  const sorted = [...pages].sort((a, b) => a - b);

  const items: (number | 'gap')[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) items.push('gap');
    items.push(p);
    prev = p;
  }

  return (
    <div className="pagination">
      {page > 1 && (
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onPage(page - 1);
          }}
        >
          &laquo; Prev
        </a>
      )}
      {items.map((p, i) =>
        p === 'gap' ? (
          <span key={`gap-${i}`}>&hellip;</span>
        ) : p === page ? (
          <span key={p} className="current">
            {p}
          </span>
        ) : (
          <a
            key={p}
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onPage(p);
            }}
          >
            {p}
          </a>
        ),
      )}
      {page < pageCount && (
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onPage(page + 1);
          }}
        >
          Next &raquo;
        </a>
      )}
      <div>{total.toLocaleString()} results</div>
    </div>
  );
}
