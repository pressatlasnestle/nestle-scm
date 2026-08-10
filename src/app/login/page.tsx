"use client";

import { useActionState } from "react";
import { signIn, type LoginState } from "./actions";

const initial: LoginState = { error: null };

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(signIn, initial);

  return (
    <div className="login-wrap">
      <form className="login-card" action={formAction}>
        <div className="brand">
          <div className="brand-mark">SM</div>
          <div>
            <div className="brand-text">SCM Media Monitor</div>
            <div className="brand-sub">Admin console</div>
          </div>
        </div>

        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          required
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          required
        />

        {state.error && <div className="login-error">{state.error}</div>}

        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
