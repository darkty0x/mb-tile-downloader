"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { buildWindowsAgentEnv, buildWindowsAgentInstallCommand, nextServerDefaults } from "../lib/overview-model";
import { configPresetVisual } from "./config-preset-visuals";
import { Icon } from "./icons";
import { AppButton, ModalShell, SelectInput, SwitchField, TextArea, TextInput } from "./ui";
import { SAMPLE_CONFIG, SECRET_LABELS, SECRET_STATUSES, defaultConfigSplitAcrossMachines, displayMachineId, displayProtocol, displayStatus, findMachineById } from "./dashboard-core";

function EmptyLine({ children }) {
  return <p className="rounded-lg border border-dashed border-[var(--ptg-outline)] p-4 text-center text-[12px] text-[var(--ptg-on-surface-variant)]">{children}</p>;
}

function normalizePathKey(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
  const windowsInstallCommand = buildWindowsAgentInstallCommand();
  const copy = async (text, label = "값") => {
    try {
      await navigator.clipboard?.writeText(String(text || ""));
      setFormNotice({ kind: "success", message: `${label} 이(가) 복사되였습니다.` });
    } catch (err) {
      setFormNotice({ kind: "error", message: `복사 실패: ${err.message}` });
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
      ["label", "봉사기이름"],
    ];
    if (formData.get("protocol") !== "agent") {
      requiredFields.push(
        ["host", "IP / Host"],
        ["username", "사용자이름"],
        ["password", "암호"],
      );
    }
    for (const [name, title] of requiredFields) {
      if (!String(formData.get(name) || "").trim()) return `${title} 이(가) 필요합니다.`;
    }
    if (formData.get("protocol") === "agent") return null;
    const port = Number(formData.get("port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "포구는 1부터 65535사이여야 합니다.";
    return null;
  }

  return (
    <section className="grid gap-4">
      <div className="rounded-[14px] border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] p-4">
        <span className="ptg-icon-well inline-flex h-10 w-10 items-center justify-center rounded-lg">
          <Icon name="servers" className="h-5 w-5" />
        </span>
        <h4 className="mt-3 text-[15px] font-[850]">봉사기조종은 Windows Agent를 리용합니다</h4>
        <p className="mt-2 text-[12.5px] font-[620] leading-5 text-[var(--ptg-on-surface-variant)]">
          원격접속자료를 보관하고 Agent `.env`를 설정한 다음 Windows 시작작업으로 Agent를 등록하십시오.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] font-[760] text-[var(--ptg-on-surface-variant)]">
          {[
            ["credentials", "1. 접속자료 보관"],
            ["console", "2. .Env 설정"],
            ["control", "3. Agent 등록"],
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
            setFormNotice({ message: `${connection.label} 이(가) 보관되였습니다. 다음 봉사기를 준비할수 있습니다.`, kind: "success" });
          } catch (err) {
            setFormNotice({ message: err.message, kind: "error" });
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <div>
          <h4 className="text-[12px] font-[850] uppercase text-[var(--ptg-on-surface-variant)]">접속 Profile</h4>
          <p className="mt-1 text-[11.5px] font-[620] text-[var(--ptg-on-surface-variant)]">관리체계 API Key 목록에 암호화되여 보관됩니다.</p>
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
          label="봉사기이름"
          name="label"
          value={label}
          onChange={(event) => {
            setEditedDefaults((current) => ({ ...current, label: true }));
            setLabel(event.target.value);
          }}
          required
        />
        <div className={protocol === "agent" ? "grid gap-2" : "grid grid-cols-[1fr_96px] gap-2"}>
          <SelectInput label="Protocol" name="protocol" value={protocol} onChange={(event) => setProtocol(event.target.value)}>
            <option value="agent">Personal Computer</option>
            <option value="rdp">RDP</option>
            <option value="ssh">SSH</option>
            <option value="winrm">WinRM</option>
            <option value="winrms">WinRM TLS</option>
          </SelectInput>
          {protocol === "agent" ? null : (
            <TextInput label="포구" name="port" type="number" min="1" max="65535" defaultValue="7777" required />
          )}
        </div>
        {protocol === "agent" ? (
          <input type="hidden" name="host" value="" />
        ) : (
          <>
            <TextInput label="IP / Host" name="host" placeholder="203.0.113.10" required />
            <TextInput label="사용자이름" name="username" defaultValue="root" autoComplete="username" required />
            <TextInput label="암호" name="password" type="password" autoComplete="new-password" required />
          </>
        )}
        <AppButton variant="filled" icon="check" type="submit" loading={submitting}>접속 Profile 보관</AppButton>
      </form>

      <TextInput label="관리체계 URL" value={dashboardUrl} onChange={(event) => setDashboardUrl(event.target.value)} />

      <section className="grid gap-2 rounded-[14px] border border-[var(--ptg-outline)] bg-white p-3">
        <h4 className="text-[12px] font-[850] uppercase text-[var(--ptg-on-surface-variant)]">Agent Token</h4>
        <div className="grid items-end gap-2 sm:grid-cols-[1fr_auto_auto]">
          <TextInput
            value={agentSetup.loading ? "읽는중..." : agentSetup.agentTokenConfigured ? agentSetup.agentToken : "설정되지 않음"}
            type="text"
            style={agentSetup.agentTokenConfigured && !showAgentToken ? { WebkitTextSecurity: "disc" } : undefined}
            readOnly
          />
          <AppButton icon={showAgentToken ? "eyeOff" : "eye"} onClick={() => setShowAgentToken((current) => !current)} disabled={!agentSetup.agentTokenConfigured}>
            {showAgentToken ? "숨기기" : "보기"}
          </AppButton>
          <AppButton icon="copy" onClick={() => copy(agentSetup.agentToken, "Agent Token")} disabled={!agentSetup.agentTokenConfigured}>
            복사
          </AppButton>
        </div>
      </section>

      <section className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-[12px] font-[850] uppercase text-[var(--ptg-on-surface-variant)]">Windows agent .env</h4>
          <AppButton icon="copy" onClick={() => copy(windowsEnv, "Windows Agent Env")}>복사</AppButton>
        </div>
        <pre className="ptg-scrollbar overflow-auto rounded-[12px] border border-[var(--ptg-outline)] bg-[#071326] p-3.5 font-mono text-[11.5px] leading-relaxed text-[#d9efff]">{windowsEnv}</pre>
      </section>

      <section className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-[12px] font-[850] uppercase text-[var(--ptg-on-surface-variant)]">Windows 시작 Agent</h4>
          <AppButton icon="copy" onClick={() => copy(windowsInstallCommand, "Windows Agent install command")}>복사</AppButton>
        </div>
        <p className="text-[12px] font-[620] leading-5 text-[var(--ptg-on-surface-variant)]">
          한번만 실행하면 Windows 재기동후에도 Agent가 배경에서 관리체계 명령을 받습니다.
        </p>
        <pre className="ptg-scrollbar overflow-auto rounded-[12px] border border-[var(--ptg-outline)] bg-[#071326] p-3.5 font-mono text-[11.5px] leading-relaxed text-[#d9efff]">{windowsInstallCommand}</pre>
      </section>

      <div className="rounded-[10px] border border-[rgba(201,121,0,0.22)] bg-[#fff8ed] px-3 py-2.5 text-[12px] font-[650] leading-5 text-[var(--ptg-on-surface-variant)]">
        같은 Machine ID를 이미 련결된 다른 Agent가 가지고 있으면 등록은 충돌상태로 되며 거부됩니다.
      </div>
    </section>
  );
}

export function EditorDrawer({ state, actions }) {
  const { editor } = state;
  const closeToCurrentContext = () => {
    if (state.selectedTab === "servers" && state.selectedMachineId) {
      actions.setEditor({ type: "server-management", machineId: state.selectedMachineId });
      return;
    }
    actions.setEditor({ type: "summary" });
  };
  if (editor.type === "summary" || editor.type === "server-detail" || editor.type === "server-management") return null;
  if (editor.type === "connection-detail") {
    const connection = state.secretPool.find((item) => item.secretId === editor.id);
    if (!connection) return null;
    return (
      <ModalShell
        title={connection.label || "봉사기상세"}
      subtitle={displayMachineId(connection.targetMachineId || connection.credential?.machineId) || "접속 Profile"}
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
        title="봉사기 추가"
        subtitle="내리적재 작업기대(Agent)를 등록합니다"
        width="w-[min(760px,calc(100vw-32px))]"
        onClose={() => actions.setEditor({ type: "summary" })}
      >
        <ServerOnboardingForm state={state} actions={actions} />
      </ModalShell>
    );
  }
  const config = editor.type === "config" ? [...state.configs, ...(state.globalConfigs || [])].find((item) => item.configId === editor.id) : null;
  const localConfig = editor.type === "local-config"
    ? (state.selectedMachine?.agentSnapshot?.configs || []).find((item) => {
        const target = normalizePathKey(editor.path);
        return [item.path, item.absolutePath, item.fileName, item.name].some((candidate) => normalizePathKey(candidate) === target);
      })
    : null;
  const env = editor.type === "env" ? state.envProfiles.find((item) => item.envProfileId === editor.id) : null;
  const secret = editor.type === "secret" ? [...state.secrets, ...state.secretPool].find((item) => item.secretId === editor.id) : null;
  const record = editor.duplicate && config ? { ...config, configId: "", name: `${config.name}-copy`, active: true } : editor.duplicate && env ? { ...env, envProfileId: "", name: `${env.name}-copy`, active: false } : config || env || secret;
  return (
    <ModalShell
      title={editorTitle(editor.type, record, editor)}
      subtitle={""}
      width="w-[min(620px,calc(100vw-32px))]"
      onClose={closeToCurrentContext}
    >
      {editor.type === "new-config" || editor.type === "config" ? <ConfigForm record={record} state={state} actions={actions} editor={editor} /> : null}
      {editor.type === "local-config" ? <LocalConfigForm record={localConfig} actions={actions} /> : null}
      {editor.type === "new-env" || editor.type === "env" ? <EnvForm record={record} actions={actions} /> : null}
      {editor.type === "new-secret" || editor.type === "secret" ? <SecretForm record={record} editor={editor} state={state} actions={actions} /> : null}
    </ModalShell>
  );
}

function editorTitle(type, record, editor = {}) {
  if (type === "new-config" && editor?.name && editor?.templateIds?.length) return "Config 류형 편집";
  if (type === "new-config") return "Config 화일 추가";
  if (type === "new-env") return ".Env 추가";
  if (type === "new-secret" && (record?.secretType === "credential" || editor.secretType === "credential")) return "계정정보 추가";
  if (type === "new-secret" && (record?.secretType === "server_rdp_credential" || editor.secretType === "server_rdp_credential")) return "봉사기계정정보 추가";
  if (type === "server-onboarding") return "봉사기 추가";
  if (type === "new-secret") return "API Key 추가";
  if (type === "config") return record?.configId ? "Config 화일 편집" : "Config 화일 복제";
  if (type === "local-config") return "Local Config 화일 편집";
  if (type === "env") return record?.envProfileId ? ".Env 편집" : ".Env 복제";
  if (type === "secret" && record?.secretType === "credential") return "계정정보 편집";
  if (type === "secret" && record?.secretType === "server_rdp_credential") return "봉사기계정정보 편집";
  if (type === "secret") return "API Key 편집";
  return "편집기";
}

function displayLocalConfigName(value) {
  return String(value || "Config 화일").replace(/\.config\.json$/i, "").replace(/\.json$/i, "");
}

function ConnectionDetail({ connection, state, actions }) {
  const targetMachineId = connection.targetMachineId || connection.credential?.machineId || connection.machineId;
  const machine = targetMachineId ? findMachineById(state.machines, targetMachineId) : null;
  const validation = state.serverValidationResults[connection.secretId];
  const isAgentOnly = connection.credential?.protocol === "agent";
  const endpoint = isAgentOnly
    ? "Agent only"
    : `${displayProtocol(connection.credential?.protocol)}://${connection.credential?.host || "N/A"}:${connection.credential?.port || "N/A"}`;
  const copy = (text) => navigator.clipboard?.writeText(String(text || "")).catch(() => {});
  return (
    <section className="grid gap-3">
      <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1">
        <DetailTile label="Protocol" value={displayProtocol(connection.credential?.protocol)} />
        <DetailTile label="끝점" value={endpoint} />
        <DetailTile label="사용자이름" value={connection.credential?.username || "필요없음"} />
        <DetailTile label="Machine ID" value={displayMachineId(targetMachineId)} />
        <DetailTile label="Agent" value={machine ? `${machine.displayName || displayMachineId(machine.machineId)} (${displayStatus(machine.status)})` : "등록되지 않음"} />
        <DetailTile label="계정정보" value={displayStatus(connection.status)} />
      </div>

      {validation ? (
        <div className="rounded-lg border border-[var(--ptg-outline)] bg-[var(--ptg-background)] p-3 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">
          망 {validation.network.skipped ? "검증생략" : validation.network.ok ? "도달가능" : "차단됨"} | Agent {displayStatus(validation.agent.status)}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-[var(--ptg-outline)] pt-3">
        <AppButton
          variant="filled"
          icon="control"
          onClick={() => actions.validateServerConnection(connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
        >
          검증
        </AppButton>
        {machine ? (
          <AppButton
            icon="servers"
            onClick={() => actions.manageServerConnection(connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
          >
            봉사기 관리
          </AppButton>
        ) : null}
        <AppButton icon="edit" onClick={() => actions.setEditor({ type: "secret", id: connection.secretId })}>계정정보 편집</AppButton>
        <AppButton icon="copy" onClick={() => copy(`${endpoint}\n${connection.credential?.username || ""}\n${displayMachineId(targetMachineId)}`)}>상세 복사</AppButton>
        <AppButton
          className="danger-button"
          icon="trash"
          onClick={() => actions.deleteRecord("secret", connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
        >
          삭제
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
          <h4 className="text-[12px] font-[800] text-[var(--ptg-on-surface)]">Config 화일 류형</h4>
          <p className="mt-0.5 text-[11px] font-[500] text-[var(--ptg-on-surface-variant)]">{templates.length}개 Config 화일 예비값 리용가능</p>
        </div>
        <div className="flex gap-1.5">
          <AppButton type="button" icon="layers" onClick={() => onChange(templates.map((template) => template.id))}>모두</AppButton>
          <AppButton type="button" icon="close" onClick={() => onChange([])}>지우기</AppButton>
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

function ConfigRangeBuilder({ actions, onDirty }) {
  const [rangeInput, setRangeInput] = useState("");
  const [zoomStart, setZoomStart] = useState("1");
  const [zoomEnd, setZoomEnd] = useState("19");
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
          <h4 className="text-[12px] font-[800] text-[var(--ptg-on-surface)]">범위</h4>
          <p className="mt-0.5 text-[11px] font-[500] text-[var(--ptg-on-surface-variant)]">선택한 Config 화일 류형에 필요합니다. 예비값에는 범위가 들어있지 않습니다.</p>
        </div>
        <AppButton type="button" icon="check" onClick={validate}>범위 검증</AppButton>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <TextInput label="Zoom 시작" name="zoomStart" type="number" min="0" max="24" value={zoomStart} onChange={(event) => setZoomStart(event.target.value)} />
        <TextInput label="Zoom 끝" name="zoomEnd" type="number" min="0" max="24" value={zoomEnd} onChange={(event) => setZoomEnd(event.target.value)} />
      </div>
      <label className="grid gap-1.5 text-[11.5px] font-[750] text-[var(--ptg-on-surface-variant)]">
        <span>범위입력</span>
        <textarea
          className="min-h-28 rounded-[10px] border border-[var(--ptg-outline)] bg-white p-3 font-mono text-[12px] leading-relaxed text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)]"
          name="rangeInput"
          onChange={(event) => {
            setRangeInput(event.target.value);
            setPreview(null);
            setError("");
            onDirty?.();
          }}
          placeholder={'lat: 37.5665, lon: 126.9780\\n\\n또는 LB: 34.799, 46.82\\nTR: 40.739, 52.272\\n\\n또는 19/312824/339498 - 19/321475/351754\\n\\n또는 [{"zoom":19,"xStart":312824,"xEnd":321475,"yStart":339498,"yEnd":351754}]'}
          spellCheck="false"
          value={rangeInput}
        />
      </label>
      {preview ? (
        <div className="rounded-lg border border-[rgba(17,124,84,0.24)] bg-[#effaf4] p-3 text-[12px] font-[650] text-[#067647]">
          범위 {preview.rangeCount}개, 타일 {preview.tiles.toLocaleString()}개로 해석되였습니다.
          <pre className="ptg-scrollbar mt-2 max-h-36 overflow-auto rounded-md bg-white/70 p-2 font-mono text-[11px] text-[var(--ptg-on-surface)]">{JSON.stringify(preview.ranges, null, 2)}</pre>
        </div>
      ) : null}
      {error ? (
        <div className="rounded-lg border border-[rgba(210,55,55,0.28)] bg-[#fff1f1] p-3 text-[12px] font-[650] text-[#b42318]">{error}</div>
      ) : null}
    </section>
  );
}

function ConfigBatchPreview({ drafts, draftTexts, rangeSummary, onDraftTextChange, onDiscard }) {
  const area = rangeSummary?.area;
  return (
    <section className="grid gap-3 rounded-lg border border-[rgba(96,64,239,0.22)] bg-[var(--ptg-primary-soft)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-[13px] font-[850] text-[var(--ptg-on-surface)]">Config 화일 미리보기</h4>
          <p className="mt-1 text-[11.5px] font-[600] text-[var(--ptg-on-surface-variant)]">
            {drafts.length}개 Config 화일이 작성됩니다. 아래 JSON을 직접 고친 다음 확정하십시오.
          </p>
          {rangeSummary ? (
            <p className="mt-1 text-[11.5px] font-[650] text-[var(--ptg-primary-dark)]">
              범위 {rangeSummary.rangeCount}개 | 타일 {Number(rangeSummary.tiles || 0).toLocaleString()}개
              {area ? ` | 추정지역 ${area.label}` : ""}
            </p>
          ) : null}
        </div>
        <AppButton type="button" icon="close" onClick={onDiscard}>미리보기 버리기</AppButton>
      </div>
      <div className="ptg-scrollbar grid max-h-[52vh] gap-3 overflow-auto pr-1">
        {drafts.map((draft, index) => (
          <label key={`${draft.machineId || "global"}-${draft.templateId || "config"}-${index}`} className="grid gap-1.5">
            <span className="flex flex-wrap items-center gap-2 text-[11.5px] font-[760] text-[var(--ptg-on-surface-variant)]">
              <strong className="text-[var(--ptg-on-surface)]">{draft.name}</strong>
              <span>{draft.machineLabel || draft.machineId || "Global"}</span>
              <span>{draft.templateLabel || draft.templateId || "Config"}</span>
            </span>
            <textarea
              className="min-h-72 resize-y rounded-[10px] border border-[var(--ptg-outline)] bg-white p-3 font-mono text-[12px] leading-relaxed text-[var(--ptg-on-surface)] transition focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)]"
              spellCheck="false"
              value={draftTexts[index] || ""}
              onChange={(event) => onDraftTextChange(index, event.target.value)}
            />
          </label>
        ))}
      </div>
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
          <h4 className="text-[12px] font-[800] text-[var(--ptg-on-surface)]">봉사기</h4>
          <p className="mt-0.5 text-[11px] font-[500] text-[var(--ptg-on-surface-variant)]">{selected.size}/{machines.length} 배정됨</p>
        </div>
        <div className="flex gap-1.5">
          <AppButton type="button" icon="servers" onClick={() => onServerChange(machines.map((machine) => machine.machineId))}>모두</AppButton>
          <AppButton type="button" icon="close" onClick={() => onServerChange([])}>지우기</AppButton>
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
        }) : <EmptyLine>등록된 봉사기가 없습니다</EmptyLine>}
      </div>
      <SwitchField
        checked={splitEnabled && splitAcrossMachines}
        className={splitEnabled ? "border-[rgba(96,64,239,0.18)] bg-[var(--ptg-primary-soft)]" : "bg-[var(--ptg-background)]"}
        description={splitEnabled ? "배정된 봉사기들에 범위을 균형분배합니다" : "봉사기를 두개이상 선택하십시오"}
        disabled={!splitEnabled}
        label="선택한 봉사기들에 범위 분할"
        name="splitAcrossMachines"
        onChange={(event) => onSplitChange(event.target.checked)}
      />
    </section>
  );
}

function ConfigForm({ record, state, actions, editor }) {
  const config = record?.config || SAMPLE_CONFIG;
  const id = record?.configId || "";
  const canUseTemplates = !id && !record?.config;
  const groupEditing = canUseTemplates && Boolean(editor?.configGroup);
  const initialTemplateIds = useMemo(
    () => (Array.isArray(editor?.templateIds) ? editor.templateIds : editor?.templateId ? [editor.templateId] : []),
    [editor?.templateId, editor?.templateIds]
  );
  const [selectedTemplateIds, setSelectedTemplateIds] = useState(initialTemplateIds);
  const initialMachineIds = () => {
    if (Array.isArray(editor?.machineIds) && editor.machineIds.length) return editor.machineIds;
    if (state.selectedMachineId) return [state.selectedMachineId];
    return state.machines[0]?.machineId ? [state.machines[0].machineId] : [];
  };
  const [selectedMachineIds, setSelectedMachineIds] = useState(initialMachineIds);
  const [splitAcrossMachines, setSplitAcrossMachines] = useState(() => defaultConfigSplitAcrossMachines(initialMachineIds()));
  const [splitAcrossMachinesTouched, setSplitAcrossMachinesTouched] = useState(false);
  const [splitByConfigTypes, setSplitByConfigTypes] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [batchPreview, setBatchPreview] = useState(null);
  const [draftTexts, setDraftTexts] = useState([]);
  const [nameValue, setNameValue] = useState(record?.name || editor?.name || "");
  const templates = state.configTemplates || [];
  const templateMode = canUseTemplates && (selectedTemplateIds.length > 0 || groupEditing);
  const effectiveMachineIds = id ? [record?.machineId || state.selectedMachineId].filter(Boolean) : selectedMachineIds;
  const effectiveMachines = effectiveMachineIds.map((machineId) => findMachineById(state.machines, machineId)).filter(Boolean);
  const missingMachineCount = effectiveMachineIds.length - effectiveMachines.length;
  const offlineMachines = effectiveMachines.filter((machine) => machine.status !== "online");
  const machineSelectionError = !effectiveMachineIds.length
    ? "봉사기를 먼저 선택하십시오"
    : missingMachineCount > 0
      ? "선택한 봉사기를 찾을수 없습니다"
      : offlineMachines.length > 0
        ? "련결된 봉사기만 선택할수 있습니다"
        : "";
  const canSubmit = !submitting && !machineSelectionError;
  const configTypeSplitEnabled = splitAcrossMachines && selectedMachineIds.length > 1 && selectedTemplateIds.length > 1;
  const clearBatchPreview = () => {
    setBatchPreview(null);
    setDraftTexts([]);
  };
  return (
    <form className="grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      if (!canSubmit) {
        actions.setNotice({ message: machineSelectionError, kind: "error" });
        return;
      }
      try {
        setSubmitting(true);
        if (groupEditing) {
          await actions.saveConfigGroup(new FormData(event.currentTarget), editor.configGroup);
          return;
        }
        if (templateMode) {
          if (!batchPreview) {
            const preview = await actions.previewConfigBatch(new FormData(event.currentTarget));
            setBatchPreview(preview);
            setDraftTexts((preview.drafts || []).map((draft) => JSON.stringify(draft.config, null, 2)));
            if (preview.suggestedName && !nameValue.trim()) setNameValue(preview.suggestedName);
            return;
          }
          const drafts = (batchPreview.drafts || []).map((draft, index) => ({
            ...draft,
            config: JSON.parse(draftTexts[index] || "{}"),
          }));
          await actions.createConfigDrafts(drafts);
          return;
        }
        await actions.saveConfig(new FormData(event.currentTarget), id);
      } catch (err) {
        actions.setNotice({ message: err.message, kind: "error" });
      } finally {
        setSubmitting(false);
      }
    }}>
      <TextInput
        label="이름"
        name="name"
        onChange={(event) => {
          setNameValue(event.target.value);
          clearBatchPreview();
        }}
        required={!templateMode || groupEditing}
        value={nameValue}
      />
      {!id ? (
        <ConfigServerPicker
          machines={state.machines}
          selectedMachineIds={selectedMachineIds}
          splitAcrossMachines={splitAcrossMachines}
          onServerChange={(machineIds) => {
            clearBatchPreview();
            setSelectedMachineIds(machineIds);
            if (machineIds.length < 2) {
              setSplitAcrossMachines(false);
              setSplitAcrossMachinesTouched(false);
            } else if (!splitAcrossMachinesTouched) {
              setSplitAcrossMachines(defaultConfigSplitAcrossMachines(machineIds));
            }
          }}
          onSplitChange={(value) => {
            clearBatchPreview();
            setSplitAcrossMachinesTouched(true);
            setSplitAcrossMachines(value);
          }}
        />
      ) : null}
      {canUseTemplates && templates.length ? (
        <ConfigTemplatePicker
          templates={templates}
          selectedTemplateIds={selectedTemplateIds}
          onChange={(templateIds) => {
            clearBatchPreview();
            setSelectedTemplateIds(templateIds);
          }}
        />
      ) : null}
      {!id ? (
        <input type="hidden" name="splitStrategy" value={configTypeSplitEnabled && splitByConfigTypes ? "configTypes" : "ranges"} />
      ) : null}
      {configTypeSplitEnabled ? (
        <SwitchField
          checked={splitByConfigTypes}
          className="border-[rgba(29,116,96,0.18)] bg-[#eefaf6]"
          description="봉사기마다 전체 범위와 서로 다른 Config 류형을 배정합니다"
          label="Config 류형별 봉사기 배정"
          name="splitByConfigTypes"
          onChange={(event) => {
            clearBatchPreview();
            setSplitByConfigTypes(event.target.checked);
          }}
        />
      ) : null}
      {machineSelectionError ? (
        <div className="rounded-lg border border-[rgba(201,121,0,0.24)] bg-[#fff8ed] p-3 text-[12px] font-[650] text-[#8a5300]">
          {machineSelectionError}
        </div>
      ) : null}
      {templateMode ? (
        <>
          {groupEditing ? null : <ConfigRangeBuilder actions={actions} onDirty={clearBatchPreview} />}
          <div className="rounded-lg border border-[rgba(96,64,239,0.18)] bg-[var(--ptg-primary-soft)] p-3 text-[12px] font-[650] text-[var(--ptg-primary-dark)]">
            {groupEditing
              ? `선택된 류형 ${selectedTemplateIds.length}개가 이 Config 그룹의 실제 배정상태로 보관됩니다.`
              : `선택된 Template ${selectedTemplateIds.length}개가 우의 범위을 리용하여 각각 실행가능한 Config 화일로 작성됩니다.`}
          </div>
          {batchPreview ? (
            <ConfigBatchPreview
              drafts={batchPreview.drafts || []}
              draftTexts={draftTexts}
              rangeSummary={batchPreview.rangeSummary}
              onDiscard={clearBatchPreview}
              onDraftTextChange={(index, value) => {
                setDraftTexts((current) => current.map((item, itemIndex) => itemIndex === index ? value : item));
              }}
            />
          ) : null}
        </>
      ) : (
        <TextArea label="Config 화일 JSON" name="config" spellCheck="false" defaultValue={JSON.stringify(config, null, 2)} />
      )}
      <div className="flex flex-wrap gap-2">
        <AppButton variant="filled" icon="check" type="submit" loading={submitting} disabled={!canSubmit}>
          {groupEditing ? "류형 보관" : templateMode ? (batchPreview ? `${batchPreview.drafts?.length || selectedTemplateIds.length}개 확정작성` : `${selectedTemplateIds.length}개 미리보기`) : "Config 화일 보관"}
        </AppButton>
        {id ? <AppButton className="danger-button" icon="trash" type="button" onClick={() => actions.deleteRecord("config", id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>삭제</AppButton> : null}
      </div>
    </form>
  );
}

function LocalConfigForm({ record, actions }) {
  const [submitting, setSubmitting] = useState(false);
  const initialConfigText = record?.content || (record?.config ? `${JSON.stringify(record.config, null, 2)}\n` : "");
  const [configText, setConfigText] = useState(initialConfigText);
  const displayPath = record?.absolutePath || record?.path || "";

  useEffect(() => {
    setConfigText(initialConfigText);
  }, [record?.path, initialConfigText]);

  if (!record) {
    return <EmptyLine>Local Config 화일을 찾을수 없습니다</EmptyLine>;
  }
  return (
    <form className="grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      if (submitting) return;
      try {
        setSubmitting(true);
        await actions.writeLocalConfig({
          configPath: record.path,
          configText,
        });
      } catch (err) {
        actions.setNotice({ message: err.message, kind: "error" });
      } finally {
        setSubmitting(false);
      }
    }}>
      <div className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
        <small className="block text-[11px] font-[760] text-[var(--ptg-on-surface-variant)]">Local Config 화일</small>
        <strong className="mt-1 block break-all text-[13px]">{displayLocalConfigName(record.name || record.fileName)}</strong>
        <p className="mt-1 break-all text-[11px] font-[560] text-[var(--ptg-on-surface-variant)]">{displayPath}</p>
        {record.parseError ? <p className="mt-2 text-[11px] font-[700] text-[var(--ptg-error)]">JSON 해석오유: {record.parseError}</p> : null}
        {!initialConfigText ? (
          <p className="mt-2 text-[11px] font-[700] text-[var(--ptg-error)]">
            Config 화일내용이 아직 Agent snapshot에 동기화되지 않았습니다. Agent를 갱신한 다음 다시 여십시오.
          </p>
        ) : null}
      </div>
      <TextArea
        label="Config 화일 JSON"
        name="configText"
        spellCheck="false"
        value={configText}
        onChange={(event) => setConfigText(event.target.value)}
      />
      <AppButton variant="filled" icon="check" type="submit" loading={submitting}>Config 화일 보관</AppButton>
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
      <TextInput label="이름" name="name" defaultValue={record?.name || "default"} required />
      <SwitchField name="active" label="활성" defaultChecked={record?.active || !id} />
      <TextArea label=".Env JSON" name="env" spellCheck="false" defaultValue={JSON.stringify(env, null, 2)} />
      <div className="flex flex-wrap gap-2">
        <AppButton variant="filled" icon="check" type="submit" loading={submitting}>.Env 보관</AppButton>
        {id ? <AppButton className="danger-button" icon="trash" type="button" onClick={() => actions.deleteRecord("env", id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>삭제</AppButton> : null}
      </div>
    </form>
  );
}

function SecretForm({ record, editor, state, actions }) {
  const id = record?.secretId || "";
  const initialSecretType = record?.secretType || editor?.secretType || "mapbox_token";
  const initialPoolSecretValue = ["mapbox_token", "proxy_txt"].includes(initialSecretType) ? String(record?.value || "") : "";
  const credential = record?.credential || {};
  const [selectedSecretType, setSelectedSecretType] = useState(initialSecretType);
  const [selectedMachineIds, setSelectedMachineIds] = useState(() => (state?.machines || []).map((machine) => machine.machineId));
  const [poolSecretValue, setPoolSecretValue] = useState(initialPoolSecretValue);
  const [poolSecretValueLoaded, setPoolSecretValueLoaded] = useState(!id || Boolean(initialPoolSecretValue));
  const [credentialMachineId, setCredentialMachineId] = useState(credential.machineId || record?.targetMachineId || "");
  const [credentialPassword, setCredentialPassword] = useState("");
  const [showCredentialPassword, setShowCredentialPassword] = useState(false);
  const [credentialPasswordLoaded, setCredentialPasswordLoaded] = useState(!id);
  const [submitting, setSubmitting] = useState(false);
  const isCredential = ["credential", "server_rdp_credential"].includes(selectedSecretType);
  const isServerCredential = selectedSecretType === "server_rdp_credential";
  const isAgentCredential = credential.protocol === "agent";
  const isPoolSecret = ["mapbox_token", "proxy_txt"].includes(selectedSecretType);
  const lockSecretType = Boolean(id || editor?.secretType || record?.secretType);
  const machines = state?.machines || [];

  useEffect(() => {
    if (id || !isPoolSecret || selectedMachineIds.length || !machines.length) return;
    setSelectedMachineIds(machines.map((machine) => machine.machineId));
  }, [id, isPoolSecret, machines.length, selectedMachineIds.length]);

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

  useEffect(() => {
    if (!id || !isPoolSecret) {
      setPoolSecretValue(String(record?.value || ""));
      setPoolSecretValueLoaded(true);
      return;
    }
    let cancelled = false;
    setPoolSecretValueLoaded(Boolean(record?.value));
    if (record?.value) setPoolSecretValue(String(record.value));
    actions.api(`/api/secrets/${encodeURIComponent(id)}`)
      .then(({ secret }) => {
        if (cancelled) return;
        setPoolSecretValue(String(secret.value || ""));
        setPoolSecretValueLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setPoolSecretValueLoaded(true);
        actions.setNotice({ message: err.message, kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [id, isPoolSecret, record?.value]);

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
          label="류형"
          name="secretType"
          value={selectedSecretType}
          onChange={(event) => setSelectedSecretType(event.target.value)}
        >
          {Object.entries(SECRET_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </SelectInput>
      )}
      {isPoolSecret ? (
        <>
          <input type="hidden" name="label" value={record?.label || selectedSecretType} />
          <input type="hidden" name="status" value={record?.status || "active"} />
        </>
      ) : (
        <TextInput
          label={isCredential ? isServerCredential ? "봉사기이름" : "Protocol이름" : "표식"}
          name="label"
          defaultValue={record?.label || ""}
          placeholder={isCredential ? isServerCredential ? "봉사기 02" : "Storj 계정" : "기본"}
        />
      )}
      {isPoolSecret ? null : isCredential && !isServerCredential ? (
        <input type="hidden" name="status" value={record?.status || "active"} />
      ) : (
        <SelectInput label="상태" name="status" defaultValue={record?.status || "active"}>
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
            label="사용자이름"
            name="credentialUsername"
            defaultValue={credential.username || ""}
            placeholder="root"
            autoComplete="username"
            required={!isAgentCredential}
          />
          <TextInput
            label="암호"
            name="credentialPassword"
            type={showCredentialPassword ? "text" : "password"}
            autoComplete="new-password"
            value={credentialPassword}
            onChange={(event) => setCredentialPassword(event.target.value)}
            placeholder={credentialPasswordLoaded ? "암호" : "암호 읽는중"}
            required={!id && !isAgentCredential}
          />
          <div className="grid grid-cols-2 gap-2 max-[460px]:grid-cols-1 sm:flex sm:justify-end">
            <AppButton
              icon={showCredentialPassword ? "eyeOff" : "eye"}
              type="button"
              onClick={() => setShowCredentialPassword((current) => !current)}
            >
              {showCredentialPassword ? "암호 숨기기" : "암호 보기"}
            </AppButton>
            <AppButton
              icon="copy"
              type="button"
              onClick={() => navigator.clipboard?.writeText(credentialPassword).catch(() => {})}
            >
              암호 복사
            </AppButton>
          </div>
        </>
      ) : (
        <TextArea
          label="값"
          name="value"
          spellCheck="false"
          value={isPoolSecret ? poolSecretValue : undefined}
          onChange={isPoolSecret ? (event) => setPoolSecretValue(event.target.value) : undefined}
          placeholder={id && !poolSecretValueLoaded ? "값 읽는중" : selectedSecretType === "proxy_txt" ? "Proxy URL을 한줄에 하나씩 또는 반점으로 갈라 넣으십시오" : "API Key를 한줄에 하나씩 또는 반점으로 갈라 넣으십시오"}
        />
      )}
      {isPoolSecret && !id ? (
        <section className="rounded-xl border border-[var(--ptg-outline)] bg-white/45 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span>
              <span className="block text-[12px] font-[800]">배정할 봉사기</span>
              <span className="text-[11px] font-[650] text-[var(--ptg-on-surface-variant)]">{selectedMachineIds.length || machines.length} / {machines.length} 선택</span>
            </span>
            <span className="flex gap-2">
              <AppButton icon="servers" type="button" onClick={() => setSelectedMachineIds(machines.map((machine) => machine.machineId))}>모두</AppButton>
              <AppButton icon="close" type="button" onClick={() => setSelectedMachineIds([])}>지우기</AppButton>
            </span>
          </div>
          <div className="grid max-h-[180px] gap-2 overflow-y-auto pr-1">
            {machines.length ? machines.map((machine) => {
              const checked = selectedMachineIds.includes(machine.machineId);
              return (
                <label
                  key={machine.machineId}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-2 transition ${checked ? "border-[var(--ptg-primary)] bg-[var(--ptg-primary-container)]" : "border-[var(--ptg-outline)] bg-white/55"}`}
                >
                  <input
                    className="sr-only"
                    type="checkbox"
                    name="machineIds"
                    value={machine.machineId}
                    checked={checked}
                    onChange={(event) => {
                      setSelectedMachineIds((current) => event.target.checked
                        ? [...new Set([...current, machine.machineId])]
                        : current.filter((machineId) => machineId !== machine.machineId));
                    }}
                  />
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--ptg-primary-container)] text-[var(--ptg-primary)]">
                    <Icon name="servers" className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate text-[12px] font-[850]">{machine.displayName || machine.machineId}</strong>
                    <span className="block truncate text-[11px] font-[650] text-[var(--ptg-on-surface-variant)]">{displayMachineId(machine.machineId)} | {displayStatus(machine.status)}</span>
                  </span>
                </label>
              );
            }) : <EmptyLine>등록된 봉사기가 없습니다. 보관하면 전체 자원풀에 추가됩니다.</EmptyLine>}
          </div>
          {selectedSecretType === "mapbox_token" ? (
            <div className="mt-3">
              <SwitchField name="validateExisting" label="API Key를 검증한 다음 배정" defaultChecked />
            </div>
          ) : null}
        </section>
      ) : null}
      <div className="mt-1 grid gap-2 border-t border-[var(--ptg-outline)] pt-3 sm:grid-cols-[auto_1fr_auto] sm:items-center">
        {id ? (
          <AppButton className="danger-button justify-self-start" icon="trash" type="button" onClick={() => actions.deleteRecord("secret", id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>삭제</AppButton>
        ) : <span />}
        <span className="hidden sm:block" />
        <AppButton className="max-sm:w-full" variant="filled" icon="check" type="submit" loading={submitting}>{isCredential ? "계정정보 보관" : "API Key 보관"}</AppButton>
      </div>
    </form>
  );
}
