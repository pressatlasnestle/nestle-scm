"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/Toast";
import { shortDate } from "@/lib/format";
import { setIntegrationKey, saveIntegrationModel } from "./actions";

export type ProviderStatus = {
  provider: string;
  name: string;
  role: string;
  hasModel: boolean;
  isSet: boolean;
  lastFour: string | null;
  modelId: string | null;
  updatedByEmail: string | null;
  updatedAt: string | null;
  /** Default model shown as a placeholder hint for LLM providers. */
  modelPlaceholder?: string;
  /** Copy shown under an unconfigured provider. */
  notConfiguredNote: string;
};

export function IntegrationCard({ status }: { status: ProviderStatus }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [editingKey, setEditingKey] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [model, setModel] = useState(status.modelId ?? "");

  function submitKey() {
    const value = keyValue;
    if (!value.trim()) {
      toast.error("Enter an API key.");
      return;
    }
    startTransition(async () => {
      const res = await setIntegrationKey(status.provider, value);
      // Clear the input immediately and unconditionally — never keep the
      // plaintext around, success or fail.
      setKeyValue("");
      setEditingKey(false);
      if (res.ok) toast.success(`${status.name} key saved.`);
      else toast.error(res.error);
    });
  }

  function submitModel() {
    startTransition(async () => {
      const res = await saveIntegrationModel(status.provider, model);
      if (res.ok) toast.success(`${status.name} model updated.`);
      else toast.error(res.error);
    });
  }

  return (
    <div className="integration-card">
      <div className="integration-card-head">
        <div>
          <div className="provider-name">{status.name}</div>
          <div className="provider-role">{status.role}</div>
        </div>
      </div>

      <div className="key-state">
        <span className={`src-dot ${status.isSet ? "ok" : "err"}`} />
        <div className="key-state-text">
          {status.isSet ? (
            <>
              Key set <span className="muted">· ends in</span>{" "}
              {status.lastFour ?? "····"}
            </>
          ) : (
            <>
              <span className="muted">Status —</span> Not configured
            </>
          )}
        </div>
      </div>

      {status.hasModel && (
        <div className="model-row">
          <span className="model-label">Model</span>
          <input
            type="text"
            className="model-input"
            value={model}
            placeholder={status.modelPlaceholder ?? "model id"}
            onChange={(e) => setModel(e.target.value)}
            disabled={pending}
          />
        </div>
      )}

      <div className="integration-meta">
        {status.isSet
          ? `Last updated by ${status.updatedByEmail ?? "—"} · ${shortDate(status.updatedAt)}`
          : status.notConfiguredNote}
      </div>

      {editingKey ? (
        <div className="integration-actions" style={{ flexDirection: "column", gap: 8 }}>
          <input
            type="password"
            className="key-input"
            autoComplete="off"
            placeholder={`Paste ${status.name} API key`}
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            disabled={pending}
            style={{ width: "100%" }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={submitKey} disabled={pending}>
              {pending ? "Saving…" : "Save key"}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                setKeyValue("");
                setEditingKey(false);
              }}
              disabled={pending}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="integration-actions">
          <button
            className={`btn btn-sm${status.isSet ? "" : " btn-primary"}`}
            onClick={() => setEditingKey(true)}
            disabled={pending}
          >
            {status.isSet ? "Replace key" : "Set key"}
          </button>
          {status.hasModel && (
            <button className="btn btn-sm" onClick={submitModel} disabled={pending}>
              Save model
            </button>
          )}
        </div>
      )}
    </div>
  );
}
