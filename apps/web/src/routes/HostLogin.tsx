import { useState, type SyntheticEvent } from "react";
import { hostLogin } from "../lib/hostApi";
import { HostLayout } from "./HostLayout";
import styles from "./host.module.css";

export function HostLogin() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await hostLogin(password);
      window.location.assign("/host");
    } catch (err) {
      const code = err instanceof Error ? err.message : "login_failed";
      setError(code === "invalid_password" ? "Incorrect password." : code);
      setBusy(false);
    }
  }

  return (
    <HostLayout>
      <h1>Host login</h1>
      {error ? <p className={styles.error}>{error}</p> : null}
      <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <label className={styles.field}>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            required
          />
        </label>
        <button type="submit" className={styles.primaryButton} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </HostLayout>
  );
}
