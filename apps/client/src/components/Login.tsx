import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { SYNTHETIC_BANNER } from "@skysentinel/shared";
import { useAuth } from "../auth.js";
import { ApiFailure } from "../api.js";

export default function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signIn(username, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={submit}>
        <div className="brand">SKYSENTINEL</div>
        <div className="sub">Counter-UAS decision trainer · SIH 2026 · PS 26247</div>
        <label htmlFor="username">Username</label>
        <input
          id="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <div className="error" role="alert">
          {error}
        </div>
        <button className="primary" disabled={busy} style={{ width: "100%", marginTop: 12 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="dim small mt">
          First boot creates a default administrator — username <span className="mono">admin</span>,
          password <span className="mono">admin</span> (printed to the server console).
        </p>
      </form>
      <p className="synthetic-banner" style={{ position: "static", marginTop: 24 }}>
        {SYNTHETIC_BANNER}
      </p>
    </div>
  );
}
