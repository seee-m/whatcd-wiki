import type { ReactNode } from 'react';

export function Box({
  title,
  right,
  children,
}: {
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="box">
      <div className="head">
        {title}
        {right && <span style={{ float: 'right' }}>{right}</span>}
      </div>
      <div className="body">{children}</div>
    </div>
  );
}
