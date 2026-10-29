import type { ReactNode } from "react";
import styles from "./host.module.css";

export function HostLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <a href="/host" className={styles.brand}>
          Host dashboard
        </a>
        <a href="/" className={styles.backLink}>
          Guest home
        </a>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
