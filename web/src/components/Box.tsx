import { useState, type ReactNode } from 'react';

export function Box({
  title,
  right,
  children,
  collapsible = true,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="box">
      <div className="head">
        <span className="box-title">{title}</span>
        <span className="box-head-right">
          {right}
          {collapsible && (
            <a
              href="#"
              className="box-toggle"
              onClick={(e) => {
                e.preventDefault();
                setCollapsed((c) => !c);
              }}
              aria-label={collapsed ? 'Expand' : 'Collapse'}
            >
              {collapsed ? '▶' : '▼'}
            </a>
          )}
        </span>
      </div>
      {!collapsed && <div className="body">{children}</div>}
    </div>
  );
}
