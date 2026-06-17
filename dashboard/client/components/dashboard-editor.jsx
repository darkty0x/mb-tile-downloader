"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { buildWindowsAgentEnv, nextServerDefaults } from "../lib/overview-model";
import { configPresetVisual } from "./config-preset-visuals";
import { Icon } from "./icons";
import { AppButton, ModalShell, SelectInput, TextArea, TextInput } from "./ui";
import { SAMPLE_CONFIG, SECRET_LABELS, SECRET_STATUSES, displayMachineId, displayProtocol, displayStatus, findMachineById } from "./dashboard-core";

function EmptyLine({ children }) {
  return <p className="rounded-lg border border-dashed border-[var(--ptg-outline)] p-4 text-center text-[12px] text-[var(--ptg-on-surface-variant)]">{children}</p>;
}

function ServerOnboardingForm({ state, actions }) {
  const defaults = useMemo(() => nextServerDefaults(state), [state.machines, state.secretPool]);
  const formRef = useRef(null);
  const [machineId, setMachineId] = useState(defaults.machineId);
  const [label, setLabel] = useState(defaults.label);
  const [protocol, setProtocol] = useState("rdp");
  const [dashboardUrl, setDashboardUrl] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const [editedDefaults, setEditedDefaults] = useState({ machineId: false, label: false });
  const [agentSetup, setAgentSetup] = useState({ agentTokenConfigured: false, agentToken: "", loading: true });
  const [showAgentToken, setShowAgentToken] = useState(false);
  const [formNotice, setFormNotice] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const windowsEnv = buildWindowsAgentEnv({ machineId, dashboardUrl, agentToken: agentSetup.agentToken });
  const copy = async (text, label = "Value") => {
    try {
      await navigator.clipboard?.writeText(String(text || ""));
      setFormNotice({ kind: "success", message: `${label} Copied.` });
    } catch (err) {
      setFormNotice({ kind: "error", message: `Copy Failed: ${err.message}` });
    }
  };

  useEffect(() => {
    if (!editedDefaults.machineId) setMachineId(defaults.machineId);
    if (!editedDefaults.label) setLabel(defaults.label);
  }, [defaults.machineId, defaults.label, editedDefaults.machineId, editedDefaults.label]);

  useEffect(() => {
    let cancelled = false;
    actions.api("/api/agent-setup")
      .then((setup) => {
        if (!cancelled) setAgentSetup({ ...setup, loading: false });
      })
      .catch((err) => {
        if (cancelled) return;
        setAgentSetup({ agentTokenConfigured: false, agentToken: "", loading: false });
        setFormNotice({ kind: "error", message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function validateServerForm(formData) {
    const requiredFields = [
      ["machineId", "Machine ID"],
      ["label", "Server Name"],
      ["host", "IP / Host"],
      ["username", "Username"],
      ["password", "Password"],
    ];
    for (const [name, title] of requiredFields) {
      if (!String(formData.get(name) || "").trim()) return `${title} Is Required.`;
    }
    const port = Number(formData.get("port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "Port Must Be Between 1 And 65535.";
    return null;
  }

  return (
    <section className="grid gap-4">
      <div className="rounded-[14px] border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] p-4">
        <span className="ptg-icon-well inline-flex h-10 w-10 items-center justify-center rounded-lg">
          <Icon name="servers" className="h-5 w-5" />
        </span>
        <h4 className="mt-3 text-[15px] font-[850]">Server Control Uses The Windows Agent</h4>
        <p className="mt-2 text-[12.5px] font-[620] leading-5 text-[var(--ptg-on-surface-variant)]">
          Save The Remote Login, Set The Agent `.env`, Then Validate The Same Machine ID From The Dashboard.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] font-[760] text-[var(--ptg-on-surface-variant)]">
          {[
            ["credentials", "1. Save Login"],
            ["console", "2. Set Env"],
            ["control", "3. Validate"],
          ].map(([icon, label]) => (
            <span key={label} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--ptg-outline)] bg-white px-2">
              <Icon name={icon} className="h-3.5 w-3.5 text-[var(--ptg-primary)]" />
              <span className="truncate">{label}</span>
            </span>
          ))}
        </div>
      </div>

      <form
        ref={formRef}
        noValidate
        className="grid gap-3 rounded-[14px] border border-[var(--ptg-outline)] bg-white p-3"
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting) return;
          const formData = new FormData(event.currentTarget);
          const validationError = validateServerForm(formData);
          if (validationError) {
            setFormNotice({ message: validationError, kind: "error" });
            return;
          }
          try {
            setSubmitting(true);
            setFormNotice(null);
            const connection = await actions.saveServerConnection(formData);
            const nextDefaults = nextServerDefaults({
              ...state,
              secretPool: [...state.secretPool, connection],
            });
            formRef.current?.reset();
            setProtocol("rdp");
            setEditedDefaults({ machineId: false, label: false });
            setMachineId(nextDefaults.machineId);
            setLabel(nextDefaults.label);
            setFormNotice({ message: `${connection.label} Saved. Next Server Is Ready.`, kind: "success" });
          } catch (err) {
            setFormNotice({ message: err.message, kind: "error" });
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <div>
          <h4 className="text-[12px] font-[850] uppercase text-[var(--ptg-on-surface-variant)]">Connection Profile</h4>
          <p className="mt-1 text-[11.5px] font-[620] text-[var(--ptg-on-surface-variant)]">Stored Encrypted In The Dashboard Secret Vault.</p>
        </div>
        {formNotice ? (
          <div
            role="alert"
            className={`rounded-[10px] border px-3 py-2.5 text-[12px] font-[760] ${
              formNotice.kind === "error"
                ? "border-[rgba(210,55,55,0.28)] bg-[#fff1f1] text-[#b42318]"
                : "border-[rgba(17,124,84,0.24)] bg-[#effaf4] text-[#067647]"
            }`}
          >
            {formNotice.message}
          </div>
        ) : null}
        <TextInput
          label="Machine ID"
          name="machineId"
          value={machineId}
          onChange={(event) => {
            setEditedDefaults((current) => ({ ...current, machineId: true }));
            setMachineId(event.target.value);
          }}
          required
        />
        <TextInput
          label="Server Name"
          name="label"
          value={label}
          onChange={(event) => {
            setEditedDefaults((current) => ({ ...current, label: true }));
            setLabel(event.target.value);
          }}
          required
        />
        <div className="grid grid-cols-[1fr_96px] gap-2">
          <SelectInput label="Protocol" name="protocol" value={protocol} onChange={(event) => setProtocol(event.target.value)}>
            <option value="rdp">RDP</option>
            <option value="ssh">SSH</option>
            <option value="winrm">WinRM</option>
            <option value="winrms">WinRM TLS</option>
          </SelectInput>
          <TextInput label="Port" name="port" type="number" min="1" max="65535" defaultValue="7777" required />
        </div>
        <TextInput label="IP / Host" name="host" placeholder="203.0.113.10" required />
        <TextInput label="Username" name="username" defaultValue="root" autoComplete="username" required />
        <TextInput label="Password" name="password" type="password" autoComplete="new-password" required />
        <AppButton variant="filled" icon="check" type="submit" loading={submitting}>Save Connection Profile</AppButton>
      </form>

      <TextInput label="Dashboard URL" value={dashboardUrl} onChange={(event) => setDashboardUrl(event.target.value)} />

      <section className="grid gap-2 rounded-[14px] border border-[var(--ptg-outline)] bg-white p-3">
        <h4 className="text-[12px] font-[850] uppercase text-[var(--ptg-on-surface-variant)]">Agent Token</h4>
        <div className="grid items-end gap-2 sm:grid-cols-[1fr_auto_auto]">
          <TextInput
            label="Sealed Token"
            value={agentSetup.loading ? "Loading..." : agentSetup.agentTokenConfigured ? agentSetup.agentToken : "Not Configured"}
            type="text"
            style={agentSetup.agentTokenConfigured && !showAgentToken ? { WebkitTextSecurity: "disc" } : undefined}
            readOnly
          />
          <AppButton icon={showAgentToken ? "eyeOff" : "eye"} onClick={() => setShowAgentToken((current) => !current)} disabled={!agentSetup.agentTokenConfigured}>
            {showAgentToken ? "Hide" : "Show"}
          </AppButton>
          <AppButton icon="copy" onClick={() => copy(agentSetup.agentToken, "Agent Token")} disabled={!agentSetup.agentTokenConfigured}>
            Copy
          </AppButton>
        </div>
      </section>

      <section className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-[12px] font-[850] uppercase text-[var(--ptg-on-surface-variant)]">Windows Agent .env</h4>
          <AppButton icon="copy" onClick={() => copy(windowsEnv, "Windows Agent Env")}>Copy</AppButton>
        </div>
        <pre className="ptg-scrollbar overflow-auto rounded-[12px] border border-[var(--ptg-outline)] bg-[#071326] p-3.5 font-mono text-[11.5px] leading-relaxed text-[#d9efff]">{windowsEnv}</pre>
      </section>

      <div className="rounded-[10px] border border-[rgba(201,121,0,0.22)] bg-[#fff8ed] px-3 py-2.5 text-[12px] font-[650] leading-5 text-[var(--ptg-on-surface-variant)]">
        If A Machine ID Is Reused While Another Live Agent Owns It, Registration Is Rejected As A Conflict.
      </div>
    </section>
  );
}

export function EditorDrawer({ state, actions }) {
  const { editor } = state;
  if (editor.type === "summary" || editor.type === "server-detail" || editor.type === "server-management") return null;
  if (editor.type === "connection-detail") {
    const connection = state.secretPool.find((item) => item.secretId === editor.id);
    if (!connection) return null;
    return (
      <ModalShell
        title={connection.label || "Server Detail"}
      subtitle={displayMachineId(connection.targetMachineId || connection.credential?.machineId) || "Connection Profile"}
        width="w-[min(680px,calc(100vw-32px))]"
        onClose={() => actions.setEditor({ type: "summary" })}
      >
        <ConnectionDetail connection={connection} state={state} actions={actions} />
      </ModalShell>
    );
  }
  if (editor.type === "server-onboarding") {
    return (
      <ModalShell
        title="Add Server"
        subtitle="Register a downloader agent connection"
        width="w-[min(760px,calc(100vw-32px))]"
        onClose={() => actions.setEditor({ type: "summary" })}
      >
        <ServerOnboardingForm state={state} actions={actions} />
      </ModalShell>
    );
  }
  const config = editor.type === "config" ? state.configs.find((item) => item.configId === editor.id) : null;
  const env = editor.type === "env" ? state.envProfiles.find((item) => item.envProfileId === editor.id) : null;
  const secret = editor.type === "secret" ? [...state.secrets, ...state.secretPool].find((item) => item.secretId === editor.id) : null;
  const record = editor.duplicate && config ? { ...config, configId: "", name: `${config.name}-copy`, active: false } : editor.duplicate && env ? { ...env, envProfileId: "", name: `${env.name}-copy`, active: false } : config || env || secret;
  return (
    <ModalShell
      title={editorTitle(editor.type, record, editor)}
      subtitle={editor.type.includes("secret") ? "Global Resource Pool" : displayMachineId(state.selectedMachine?.machineId)}
      width="w-[min(620px,calc(100vw-32px))]"
      onClose={() => actions.setEditor({ type: "summary" })}
    >
      {editor.type === "new-config" || editor.type === "config" ? <ConfigForm record={record} state={state} actions={actions} editor={editor} /> : null}
      {editor.type === "new-env" || editor.type === "env" ? <EnvForm record={record} actions={actions} /> : null}
      {editor.type === "new-secret" || editor.type === "secret" ? <SecretForm record={record} editor={editor} actions={actions} /> : null}
    </ModalShell>
  );
}

function editorTitle(type, record, editor = {}) {
  if (type === "new-config") return "Add Config";
  if (type === "new-env") return "Add Env";
  if (type === "new-secret" && (record?.secretType === "credential" || editor.secretType === "credential")) return "Add Credential";
  if (type === "new-secret" && (record?.secretType === "server_rdp_credential" || editor.secretType === "server_rdp_credential")) return "Add Server Credential";
  if (type === "server-onboarding") return "Add Server";
  if (type === "new-secret") return "Add Secret";
  if (type === "config") return record?.configId ? "Edit Config" : "Duplicate Config";
  if (type === "env") return record?.envProfileId ? "Edit Env" : "Duplicate Env";
  if (type === "secret" && record?.secretType === "credential") return "Edit Credential";
  if (type === "secret" && record?.secretType === "server_rdp_credential") return "Edit Server Credential";
  if (type === "secret") return "Edit Secret";
  return "Editor";
}

function ConnectionDetail({ connection, state, actions }) {
  const targetMachineId = connection.targetMachineId || connection.credential?.machineId || connection.machineId;
  const machine = targetMachineId ? findMachineById(state.machines, targetMachineId) : null;
  const validation = state.serverValidationResults[connection.secretId];
  const endpoint = `${displayProtocol(connection.credential?.protocol)}://${connection.credential?.host || "N/A"}:${connection.credential?.port || "N/A"}`;
  const copy = (text) => navigator.clipboard?.writeText(String(text || "")).catch(() => {});
  return (
    <section className="grid gap-3">
      <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
        <DetailTile label="Protocol" value={displayProtocol(connection.credential?.protocol)} />
        <DetailTile label="Endpoint" value={endpoint} />
        <DetailTile label="Username" value={connection.credential?.username || "N/A"} />
        <DetailTile label="Machine ID" value={displayMachineId(targetMachineId)} />
        <DetailTile label="Agent" value={machine ? `${machine.displayName || displayMachineId(machine.machineId)} (${displayStatus(machine.status)})` : "Not Registered"} />
        <DetailTile label="Credential" value={displayStatus(connection.status)} />
      </div>

      {validation ? (
        <div className="rounded-lg border border-[var(--ptg-outline)] bg-[var(--ptg-background)] p-3 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">
          Network {validation.network.ok ? "Reachable" : "Blocked"} | Agent {displayStatus(validation.agent.status)}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-[var(--ptg-outline)] pt-3">
        <AppButton
          variant="filled"
          icon="control"
          onClick={() => actions.validateServerConnection(connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
        >
          Validate
        </AppButton>
        {machine ? (
          <AppButton
            icon="servers"
            onClick={() => actions.manageServerConnection(connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
          >
            Manage Server
          </AppButton>
        ) : null}
        <AppButton icon="edit" onClick={() => actions.setEditor({ type: "secret", id: connection.secretId })}>Edit Credentials</AppButton>
        <AppButton icon="copy" onClick={() => copy(`${endpoint}\n${connection.credential?.username || ""}\n${displayMachineId(targetMachineId)}`)}>Copy Details</AppButton>
        <AppButton
          className="danger-button"
          icon="trash"
          onClick={() => actions.deleteRecord("secret", connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
        >
          Delete
        </AppButton>
      </div>
    </section>
  );
}

function DetailTile({ label, value }) {
  return (
    <span className="min-w-0 rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
      <small className="block truncate text-[11px] font-[760] text-[var(--ptg-on-surface-variant)]">{label}</small>
      <strong className="mt-1 block truncate text-[13px] font-[850] text-[var(--ptg-on-surface)]">{value}</strong>
    </span>
  );
}

function ConfigTemplatePicker({ templates, selectedTemplateIds, onChange }) {
  const selected = new Set(selectedTemplateIds);
  return (
    <section className="grid gap-2 rounded-lg border border-[var(--ptg-outline)] bg-[var(--ptg-background)] p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-[12px] font-[800] text-[var(--ptg-on-surface)]">Config Types</h4>
          <p className="mt-0.5 text-[11px] font-[500] text-[var(--ptg-on-surface-variant)]">{templates.length} config presets available</p>
        </div>
        <div className="flex gap-1.5">
          <AppButton type="button" icon="layers" onClick={() => onChange(templates.map((template) => template.id))}>All</AppButton>
          <AppButton type="button" icon="close" onClick={() => onChange([])}>Clear</AppButton>
        </div>
      </div>
      <div className="ptg-scrollbar ptg-picker-list max-h-72 overflow-auto pr-1">
        {templates.map((template) => {
          const checked = selected.has(template.id);
          const visual = configPresetVisual(template);
          return (
            <label
              key={template.id}
              className="state-layer ptg-picker-row cursor-pointer"
              data-selected={checked ? "true" : "false"}
            >
              <input
                checked={checked}
                className="sr-only"
                name="templateIds"
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selectedTemplateIds, template.id]
                    : selectedTemplateIds.filter((id) => id !== template.id);
                  onChange(next);
                }}
                type="checkbox"
                value={template.id}
              />
              <span className={`inline-flex h-8 w-8 items-center justify-center rounded-xl border ${checked ? visual.badge : visual.shell}`}>
                <Icon name={visual.icon} className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <strong className="block truncate text-[12.5px] font-[780]">{template.label}</strong>
                <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">
                  {template.provider} | {template.layer} | {template.format}
                </small>
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function ConfigRangeBuilder({ actions }) {
  const [rangeInput, setRangeInput] = useState("");
  const [zoomStart, setZoomStart] = useState("");
  const [zoomEnd, setZoomEnd] = useState("");
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");

  const validate = async () => {
    setError("");
    setPreview(null);
    try {
      const result = await actions.api("/api/ranges/parse", {
        method: "POST",
        body: JSON.stringify({
          input: rangeInput,
          zoomStart,
          zoomEnd,
        }),
      });
      setPreview(result);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="grid gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-[12px] font-[800] text-[var(--ptg-on-surface)]">Ranges</h4>
          <p className="mt-0.5 text-[11px] font-[500] text-[var(--ptg-on-surface-variant)]">Required for selected config types. Presets do not include ranges.</p>
        </div>
        <AppButton type="button" icon="check" onClick={validate}>Validate Range</AppButton>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <TextInput label="Zoom Start" name="zoomStart" type="number" min="0" max="24" value={zoomStart} onChange={(event) => setZoomStart(event.target.value)} placeholder="19" />
        <TextInput label="Zoom End" name="zoomEnd" type="number" min="0" max="24" value={zoomEnd} onChange={(event) => setZoomEnd(event.target.value)} placeholder="19" />
      </div>
      <label className="grid gap-1.5 text-[11.5px] font-[750] text-[var(--ptg-on-surface-variant)]">
        <span>Range Input</span>
        <textarea
          className="min-h-28 rounded-[10px] border border-[var(--ptg-outline)] bg-white p-3 font-mono text-[12px] leading-relaxed text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)]"
          name="rangeInput"
          onChange={(event) => {
            setRangeInput(event.target.value);
            setPreview(null);
            setError("");
          }}
          placeholder={'LB: 34.799, 46.82\\nTR: 40.739, 52.272\\n\\nor 19/312824/339498 - 19/321475/351754\\n\\nor [{"zoom":19,"xStart":312824,"xEnd":321475,"yStart":339498,"yEnd":351754}]'}
          spellCheck="false"
          value={rangeInput}
        />
      </label>
      {preview ? (
        <div className="rounded-lg border border-[rgba(17,124,84,0.24)] bg-[#effaf4] p-3 text-[12px] font-[650] text-[#067647]">
          Parsed {preview.rangeCount} range{preview.rangeCount === 1 ? "" : "s"} with {preview.tiles.toLocaleString()} tiles.
          <pre className="ptg-scrollbar mt-2 max-h-36 overflow-auto rounded-md bg-white/70 p-2 font-mono text-[11px] text-[var(--ptg-on-surface)]">{JSON.stringify(preview.ranges, null, 2)}</pre>
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-[rgba(210,55,55,0.28)] bg-[#fff1f1] p-3 text-[12px] font-[650] text-[#b42318]">{error}</div>
      ) : null}
    </section>
  );
}

function ConfigServerPicker({ machines, selectedMachineIds, splitAcrossMachines, onServerChange, onSplitChange }) {
  const selected = new Set(selectedMachineIds);
  const splitEnabled = selectedMachineIds.length > 1;
  return (
    <section className="grid gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-[12px] font-[800] text-[var(--ptg-on-surface)]">Servers</h4>
          <p className="mt-0.5 text-[11px] font-[500] text-[var(--ptg-on-surface-variant)]">{selected.size}/{machines.length} assigned</p>
        </div>
        <div className="flex gap-1.5">
          <AppButton type="button" icon="servers" onClick={() => onServerChange(machines.map((machine) => machine.machineId))}>All</AppButton>
          <AppButton type="button" icon="close" onClick={() => onServerChange([])}>Clear</AppButton>
        </div>
      </div>
      <div className="ptg-scrollbar ptg-picker-list max-h-56 overflow-auto pr-1">
        {machines.length ? machines.map((machine) => {
          const checked = selected.has(machine.machineId);
          return (
            <label
              key={machine.machineId}
              className="state-layer ptg-picker-row cursor-pointer"
              data-selected={checked ? "true" : "false"}
            >
              <input
                checked={checked}
                className="sr-only"
                name="machineIds"
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selectedMachineIds, machine.machineId]
                    : selectedMachineIds.filter((id) => id !== machine.machineId);
                  onServerChange(next);
                  if (next.length < 2) onSplitChange(false);
                }}
                type="checkbox"
                value={machine.machineId}
              />
              <span className={`inline-flex h-8 w-8 items-center justify-center rounded-xl ${checked ? "bg-[var(--ptg-primary)] text-white" : "bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]"}`}>
                <Icon name="servers" className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <strong className="block truncate text-[12.5px] font-[780]">{machine.displayName || displayMachineId(machine.machineId)}</strong>
                <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{displayMachineId(machine.machineId)} | {displayStatus(machine.status)}</small>
              </span>
            </label>
          );
        }) : <EmptyLine>No registered servers</EmptyLine>}
      </div>
      <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-[700] ${
        splitEnabled ? "border-[rgba(96,64,239,0.18)] bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary-dark)]" : "border-[var(--ptg-outline)] bg-[var(--ptg-background)] text-[var(--ptg-on-surface-variant)]"
      }`}>
        <input
          checked={splitEnabled && splitAcrossMachines}
          disabled={!splitEnabled}
          name="splitAcrossMachines"
          onChange={(event) => onSplitChange(event.target.checked)}
          type="checkbox"
        />
        Split ranges across selected servers
      </label>
    </section>
  );
}

function ConfigForm({ record, state, actions, editor }) {
  const config = record?.config || SAMPLE_CONFIG;
  const id = record?.configId || "";
  const canUseTemplates = !id && !record?.config;
  const initialTemplateIds = useMemo(
    () => (Array.isArray(editor?.templateIds) ? editor.templateIds : editor?.templateId ? [editor.templateId] : []),
    [editor?.templateId, editor?.templateIds]
  );
  const [selectedTemplateIds, setSelectedTemplateIds] = useState(initialTemplateIds);
  const [selectedMachineIds, setSelectedMachineIds] = useState(() => state.selectedMachineId ? [state.selectedMachineId] : state.machines[0]?.machineId ? [state.machines[0].machineId] : []);
  const [splitAcrossMachines, setSplitAcrossMachines] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const templates = state.configTemplates || [];
  const templateMode = canUseTemplates && selectedTemplateIds.length > 0;
  const defaultActive = record?.active ?? !id;
  return (
    <form className="grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      if (submitting) return;
      try {
        setSubmitting(true);
        await actions.saveConfig(new FormData(event.currentTarget), id);
      } catch (err) {
        actions.setNotice({ message: err.message, kind: "error" });
      } finally {
        setSubmitting(false);
      }
    }}>
      <TextInput label="Name" name="name" defaultValue={record?.name || "dashboard-config"} required />
      <label className="flex items-center gap-2 text-[12px] font-[700] text-[var(--ptg-on-surface-variant)]"><input name="active" type="checkbox" defaultChecked={defaultActive} /> Active</label>
      {!id ? (
        <ConfigServerPicker
          machines={state.machines}
          selectedMachineIds={selectedMachineIds}
          splitAcrossMachines={splitAcrossMachines}
          onServerChange={setSelectedMachineIds}
          onSplitChange={setSplitAcrossMachines}
        />
      ) : null}
      {canUseTemplates && templates.length ? (
        <ConfigTemplatePicker
          templates={templates}
          selectedTemplateIds={selectedTemplateIds}
          onChange={setSelectedTemplateIds}
        />
      ) : null}
      {templateMode ? (
        <>
          <ConfigRangeBuilder actions={actions} />
          <div className="rounded-lg border border-[rgba(96,64,239,0.18)] bg-[var(--ptg-primary-soft)] p-3 text-[12px] font-[650] text-[var(--ptg-primary-dark)]">
            {selectedTemplateIds.length} selected type{selectedTemplateIds.length === 1 ? "" : "s"} will create separate runnable configs using the ranges above.
          </div>
        </>
      ) : (
        <TextArea label="Config JSON" name="config" spellCheck="false" defaultValue={JSON.stringify(config, null, 2)} />
      )}
      <div className="flex flex-wrap gap-2">
        <AppButton variant="filled" icon="check" type="submit" loading={submitting}>{templateMode ? `Create ${selectedTemplateIds.length}` : "Save Config"}</AppButton>
        {id ? <AppButton className="danger-button" icon="trash" type="button" onClick={() => actions.deleteRecord("config", id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>Delete</AppButton> : null}
      </div>
    </form>
  );
}

function EnvForm({ record, actions }) {
  const env = record?.env || { TILE_DOWNLOADER_MAX_CONCURRENCY: 64 };
  const id = record?.envProfileId || "";
  const [submitting, setSubmitting] = useState(false);
  return (
    <form className="grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      if (submitting) return;
      try {
        setSubmitting(true);
        await actions.saveEnv(new FormData(event.currentTarget), id);
      } catch (err) {
        actions.setNotice({ message: err.message, kind: "error" });
      } finally {
        setSubmitting(false);
      }
    }}>
      <TextInput label="Name" name="name" defaultValue={record?.name || "default"} required />
      <label className="flex items-center gap-2 text-[12px] font-[700] text-[var(--ptg-on-surface-variant)]"><input name="active" type="checkbox" defaultChecked={record?.active || !id} /> Active</label>
      <TextArea label="Env JSON" name="env" spellCheck="false" defaultValue={JSON.stringify(env, null, 2)} />
      <div className="flex flex-wrap gap-2">
        <AppButton variant="filled" icon="check" type="submit" loading={submitting}>Save Env</AppButton>
        {id ? <AppButton className="danger-button" icon="trash" type="button" onClick={() => actions.deleteRecord("env", id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>Delete</AppButton> : null}
      </div>
    </form>
  );
}

function SecretForm({ record, editor, actions }) {
  const id = record?.secretId || "";
  const initialSecretType = record?.secretType || editor?.secretType || "mapbox_token";
  const credential = record?.credential || {};
  const [selectedSecretType, setSelectedSecretType] = useState(initialSecretType);
  const [credentialMachineId, setCredentialMachineId] = useState(credential.machineId || record?.targetMachineId || "");
  const [credentialPassword, setCredentialPassword] = useState("");
  const [showCredentialPassword, setShowCredentialPassword] = useState(false);
  const [credentialPasswordLoaded, setCredentialPasswordLoaded] = useState(!id);
  const [submitting, setSubmitting] = useState(false);
  const isCredential = ["credential", "server_rdp_credential"].includes(selectedSecretType);
  const isServerCredential = selectedSecretType === "server_rdp_credential";
  const lockSecretType = Boolean(id || editor?.secretType || record?.secretType);

  useEffect(() => {
    if (!id || !isCredential) {
      setCredentialPassword("");
      setCredentialPasswordLoaded(true);
      return;
    }
    let cancelled = false;
    setCredentialPasswordLoaded(false);
    actions.api(`/api/secrets/${encodeURIComponent(id)}`)
      .then(({ secret }) => {
        if (cancelled) return;
        const value = JSON.parse(secret.value || "{}");
        setCredentialMachineId(String(value.machineId || ""));
        setCredentialPassword(String(value.password || ""));
        setCredentialPasswordLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setCredentialPasswordLoaded(true);
        actions.setNotice({ message: err.message, kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [id, isCredential]);

  return (
    <form className="grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      if (submitting) return;
      try {
        setSubmitting(true);
        await actions.saveSecret(new FormData(event.currentTarget), id, record?.secretType);
      } catch (err) {
        actions.setNotice({ message: err.message, kind: "error" });
      } finally {
        setSubmitting(false);
      }
    }}>
      <input type="hidden" name="machineId" value={record?.machineId || ""} />
      {lockSecretType ? (
        <input type="hidden" name="secretType" value={selectedSecretType} />
      ) : (
        <SelectInput
          label="Type"
          name="secretType"
          value={selectedSecretType}
          onChange={(event) => setSelectedSecretType(event.target.value)}
        >
          {Object.entries(SECRET_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </SelectInput>
      )}
      <TextInput
        label={isCredential ? isServerCredential ? "Server Name" : "Protocol Name" : "Label"}
        name="label"
        defaultValue={record?.label || ""}
        placeholder={isCredential ? isServerCredential ? "Server 02" : "Storj Account" : "Primary"}
      />
      {isCredential && !isServerCredential ? (
        <input type="hidden" name="status" value={record?.status || "active"} />
      ) : (
        <SelectInput label="Status" name="status" defaultValue={record?.status || "active"}>
          {SECRET_STATUSES.map((status) => <option key={status} value={status}>{displayStatus(status)}</option>)}
        </SelectInput>
      )}
      {isCredential ? (
        <>
          <input type="hidden" name="existingCredentialProtocolUrl" value={credential.protocolUrl || ""} />
          <input type="hidden" name="existingCredentialMachineId" value={credential.machineId || record?.targetMachineId || ""} />
          <input type="hidden" name="existingCredentialUsername" value={credential.username || ""} />
          <TextInput
            label="Protocol URL"
            name="credentialProtocolUrl"
            type="url"
            defaultValue={credential.protocolUrl || ""}
            placeholder={isServerCredential ? "rdp://203.0.113.10:7777" : "https://dashboard.example.com"}
            required
          />
          {isServerCredential ? (
            <TextInput
              label="Agent ID"
              name="credentialMachineId"
              value={credentialMachineId}
              onChange={(event) => setCredentialMachineId(event.target.value)}
              placeholder="SERVER-02"
              required
            />
          ) : (
            <input type="hidden" name="credentialMachineId" value="" />
          )}
          <TextInput
            label="Username"
            name="credentialUsername"
            defaultValue={credential.username || ""}
            placeholder="root"
            autoComplete="username"
            required
          />
          <TextInput
            label="Password"
            name="credentialPassword"
            type={showCredentialPassword ? "text" : "password"}
            autoComplete="new-password"
            value={credentialPassword}
            onChange={(event) => setCredentialPassword(event.target.value)}
            placeholder={credentialPasswordLoaded ? "Password" : "Loading Password"}
            required={!id}
          />
          <div className="grid grid-cols-2 gap-2 max-[460px]:grid-cols-1 sm:flex sm:justify-end">
            <AppButton
              icon={showCredentialPassword ? "eyeOff" : "eye"}
              type="button"
              onClick={() => setShowCredentialPassword((current) => !current)}
            >
              {showCredentialPassword ? "Hide Password" : "Show Password"}
            </AppButton>
            <AppButton
              icon="copy"
              type="button"
              onClick={() => navigator.clipboard?.writeText(credentialPassword).catch(() => {})}
            >
              Copy Password
            </AppButton>
          </div>
        </>
      ) : (
        <TextArea
          label="Value"
          name="value"
          spellCheck="false"
          placeholder={id ? "Leave blank to keep current value" : selectedSecretType === "proxy_txt" ? "Paste one proxy URL per line or comma-separated proxy URLs" : "Paste one API key per line or comma-separated keys"}
        />
      )}
      <div className="mt-1 grid gap-2 border-t border-[var(--ptg-outline)] pt-3 sm:grid-cols-[auto_1fr_auto] sm:items-center">
        {id ? (
          <AppButton className="danger-button justify-self-start" icon="trash" type="button" onClick={() => actions.deleteRecord("secret", id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>Delete</AppButton>
        ) : <span />}
        <span className="hidden sm:block" />
        <AppButton className="max-sm:w-full" variant="filled" icon="check" type="submit" loading={submitting}>{isCredential ? "Save Credential" : "Save Secret"}</AppButton>
      </div>
    </form>
  );
}
