// Page furniture shared across pages.
import type { ReactNode } from "react";
import type { Identity } from "spacetimedb";
import { BAG_SIZE } from "./util";

const cx = (...names: (string | false | undefined)[]) =>
  names.filter(Boolean).join(" ");

// The page title row. `status` sits opposite the title; `subtitle` sits
// beneath it. Anything in `children` follows on the same row.
export function PageHeader({
  title,
  status,
  subtitle,
  children,
}: {
  title: ReactNode;
  status?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="header full">
      {subtitle === undefined ? (
        <h1>{title}</h1>
      ) : (
        <div>
          <h1>{title}</h1>
          <span className="status">{subtitle}</span>
        </div>
      )}
      {status !== undefined && <span className="status">{status}</span>}
      {children}
    </div>
  );
}

export function Panel({
  title,
  full,
  className,
  children,
}: {
  title?: ReactNode;
  full?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cx("panel", full && "full", className)}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

// How far through the bag a match is.
export function BagBar({ bagTotal }: { bagTotal: number }) {
  const drawn = BAG_SIZE - bagTotal;
  return (
    <div className="bag-bar">
      <div style={{ width: `${(drawn / BAG_SIZE) * 100}%` }} />
    </div>
  );
}

export function BagCount({ bagTotal }: { bagTotal: number }) {
  return (
    <span className="status">
      {BAG_SIZE - bagTotal} of {BAG_SIZE} tiles drawn
    </span>
  );
}

// An identity cut down to something that fits in a table cell.
export function ShortIdentity({ identity }: { identity: Identity }) {
  const hex = identity.toHexString();
  return (
    <code className="short-id" title={hex}>
      {hex.slice(0, 16)}…
    </code>
  );
}
