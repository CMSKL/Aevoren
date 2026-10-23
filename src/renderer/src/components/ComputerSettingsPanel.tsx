import { useCallback, useEffect, useRef, useState } from "react";
import type { HostComputerStatus } from "@shared/host-computer-contracts";
import type { HostBrowserPairing, HostComputerTarget } from "@shared/host-computer-targets";
import { DockerStatusCard } from "./EnvironmentPanel";
import { BuiltinComputerPanel } from "./ComputerPanel";

type Scope = { sessionId: string; executorBotId: string; name: string };
function targetKey(target: HostComputerTarget | null | undefined): string {
  return !target ? "" : target.kind === "app" ? `app:${target.pid}:${target.startedAt}:${target.windowId}` : `browser:${target.connectionId}:${target.tabId}`;
}
function targetLabel(target: HostComputerTarget): string { return target.kind === "app" ? `${target.appName} · ${target.title || "未命名窗口"}` : `浏览器标签页 · ${target.title || target.url}`; }
export function ComputerSettingsPanel({ scopes }: { scopes: Scope[] }): React.JSX.Element {
  const [status, setStatus] = useState<HostComputerStatus | null>(null), [error, setError] = useState<string | null>(null), [pending, setPending] = useState(false);
  const [advanced, setAdvanced] = useState(false), [selected, setSelected] = useState("");
  const [targets, setTargets] = useState<HostComputerTarget[]>([]), [loadingTargets, setLoadingTargets] = useState(true);
  const [draftTarget, setDraftTarget] = useState<HostComputerTarget | null | undefined>(undefined);
  const [pairing, setPairing] = useState<HostBrowserPairing | null>(null);
  const requests = useRef({ sequence: 0 });
  const scope = scopes.find(scope => scope.executorBotId === selected) ?? scopes[0];
  const load = useCallback((): Promise<void> => {
    const tracker = requests.current, request = ++tracker.sequence;
    return Promise.allSettled([window.aevorenBot.hostComputer.status(), window.aevorenBot.hostComputer.targets()]).then(([statusResult, targetsResult]) => {
    if (request !== tracker.sequence) return;
    let message: string | null = null;
    if (statusResult.status === "fulfilled" && statusResult.value.ok) { const next = statusResult.value.data; setStatus(current => current && (current.configuration.version > next.configuration.version || current.epoch > next.epoch) ? current : next); }
    else { setStatus(null); message = statusResult.status === "fulfilled" && !statusResult.value.ok ? statusResult.value.error.safeMessage : "未能读取电脑设置，请重试。"; }
    if (targetsResult.status === "fulfilled" && targetsResult.value.ok) setTargets(targetsResult.value.data);
    else { setTargets([]); message ??= targetsResult.status === "fulfilled" && !targetsResult.value.ok ? targetsResult.value.error.safeMessage : "未能读取可用目标，请重试。"; }
    setLoadingTargets(false); setError(message);
    });
  }, []);
  useEffect(() => { const tracker = requests.current; void load(); return () => { tracker.sequence++; }; }, [load]);
  async function save(patch: Partial<HostComputerStatus["configuration"]>): Promise<void> {
    if (!status || pending) return; setPending(true); setError(null);
    try {
      const result = await window.aevorenBot.hostComputer.save({ ...status.configuration, ...patch });
      if (result.ok) { setStatus(result.data); if ("hostTarget" in patch) setDraftTarget(undefined); if (patch.enabled) { setLoadingTargets(true); void load(); } }
      else {
        setError(result.error.safeMessage);
        if (result.error.code === "COMPUTER_TASK_CONFLICT") {
          const current = await window.aevorenBot.hostComputer.status();
          if (current.ok) setStatus(current.data);
        }
      }
    } catch { setError("未能保存电脑设置，当前选择已保留。"); } finally { setPending(false); }
  }
  async function pairBrowser(): Promise<void> {
    setPending(true); setError(null);
    try { const result = await window.aevorenBot.hostComputer.pairBrowser(); if (result.ok) { setPairing(result.data); await load(); } else setError(result.error.safeMessage); }
    catch { setError("未能生成配对码，请重试。"); } finally { setPending(false); }
  }
  async function revokeBrowser(): Promise<void> {
    setPending(true); setError(null);
    try { const result = await window.aevorenBot.hostComputer.revokeBrowser(); if (result.ok) { setPairing(null); await load(); } else setError(result.error.safeMessage); }
    catch { setError("未能确认浏览器连接已撤销，请刷新后检查。"); } finally { setPending(false); }
  }
  const chosen = draftTarget === undefined ? status?.configuration.hostTarget : draftTarget;
  const chosenKey = targetKey(chosen), savedTarget = status?.configuration.hostTarget;
  const available = !loadingTargets && targets.some(target => targetKey(target) === targetKey(savedTarget));
  const ready = Boolean(status?.supported && status.configuration.enabled && savedTarget && available && (savedTarget.kind === "browser" ? status.browserConnected : status.helperAvailable && status.accessibility && status.screenPermission === "granted"));
  const dirty = draftTarget !== undefined && chosenKey !== targetKey(savedTarget);
  return <section className="settings-panel" aria-label="电脑设置">
    <div className="settings-section-heading"><h2>电脑</h2><p>选择 Bot 使用的电脑。电脑执行模型仍在“模型”设置中管理。</p></div>
    <h3>你的电脑</h3>
    <div className="settings-card settings-form-group">
      <label className="settings-row"><span><strong>允许操作这台 Mac</strong><small>选择一个后台应用窗口或已共享的浏览器标签页。任务仅操作所选目标，所有 Bot 按顺序执行。</small></span><input aria-label="允许操作这台 Mac" type="checkbox" checked={status?.configuration.enabled ?? false} disabled={pending || !status?.supported} onChange={event => void save({ enabled: event.target.checked, ...(!event.target.checked ? { target: "builtin" as const } : {}) })} /></label>
      {status?.configuration.enabled ? <>
        <label className="settings-row"><span><strong>本机操作目标</strong><small>{loadingTargets ? "正在读取可用窗口与已共享标签页" : "选择应用窗口或已共享的标签页；不支持后台操作时会明确提示。更换目标会暂停当前本机任务。"}</small></span><select aria-label="本机操作目标" value={chosenKey} disabled={pending || loadingTargets} onChange={event => setDraftTarget(targets.find(target => targetKey(target) === event.target.value) ?? null)}><option value="">选择窗口或标签页…</option>{chosen && !targets.some(target => targetKey(target) === chosenKey) ? <option value={chosenKey} disabled>{targetLabel(chosen)} · 暂不可用</option> : null}{targets.map(target => <option key={targetKey(target)} value={targetKey(target)}>{targetLabel(target)}</option>)}</select></label>
        <div className="computer-actions"><button type="button" className="secondary-button" disabled={pending || !dirty || loadingTargets || Boolean(chosen && !targets.some(target => targetKey(target) === chosenKey))} onClick={() => void save({ hostTarget: chosen ?? null })}>保存目标</button><button type="button" className="text-button" disabled={pending || loadingTargets} onClick={() => { setLoadingTargets(true); void load(); }}>刷新目标</button></div>
        {!chosen ? <p className="computer-note">先选择并保存目标，再交给 AI。</p> : null}
        <div className="settings-row"><span><strong>浏览器连接</strong><small>{status.browserConnected ? "已连接，请在浏览器扩展中共享要操作的标签页。" : "连接浏览器后，可使用已有登录状态的共享标签页。"}</small></span><div className="computer-actions"><button type="button" className="secondary-button" disabled={pending} onClick={() => void pairBrowser()}>{pairing ? "重新生成配对码" : "连接浏览器"}</button>{status.browserConnected || pairing ? <button type="button" className="text-button" disabled={pending} onClick={() => void revokeBrowser()}>撤销浏览器连接</button> : null}</div></div>
        {pairing ? <div className="settings-form-group" role="group" aria-label="浏览器配对"><label className="field"><span>配对码</span><input aria-label="浏览器配对码" readOnly value={pairing.code} /></label><label className="field"><span>连接地址</span><input aria-label="浏览器连接地址" readOnly value={pairing.endpoint} /></label><p className="computer-note">有效至 {new Date(pairing.expiresAt).toLocaleTimeString()}。完成配对并共享标签页后，点击“刷新目标”。</p></div> : null}
        <details><summary>首次连接浏览器</summary><p className="computer-note">打开扩展文件夹，在浏览器的扩展管理页载入扩展。点击“连接浏览器”，将连接地址和配对码填入扩展，然后共享你要操作的标签页。</p><button type="button" className="text-button" disabled={pending} onClick={() => { void window.aevorenBot.hostComputer.openBrowserExtension().then(result => { if (!result.ok) setError(result.error.safeMessage); }).catch(() => setError("未能打开扩展文件夹。")); }}>打开扩展文件夹</button></details>
      </> : null}
      <details><summary>应用窗口权限</summary><div className="settings-row"><span><strong>系统权限</strong><small>{status ? `屏幕录制：${status.screenPermission === "granted" ? "已允许" : "未允许"} · 辅助功能：${status.accessibility ? "已允许" : "未允许"} · 操作组件：${status.helperAvailable ? "已安装" : "不可用"}` : "正在检查"}</small></span></div><p className="computer-note">这些权限用于应用窗口；已连接的浏览器标签页不需要屏幕录制权限。</p>
        {status?.supported ? <div className="computer-actions">{(["screen", "accessibility"] as const).map(kind => <button type="button" className="text-button" key={kind} disabled={pending} onClick={() => { void window.aevorenBot.hostComputer.permission({ kind }).then(result => { if (!result.ok) setError(result.error.safeMessage); }).catch(() => setError("未能打开系统权限设置。")); }}>{kind === "screen" ? "设置屏幕录制权限" : "设置辅助功能权限"}</button>)}<button type="button" className="text-button" disabled={pending || loadingTargets} onClick={() => { setLoadingTargets(true); void load(); }}>刷新权限</button></div> : null}
      </details>
    </div>
    {status?.configuration.enabled ? <div className="computer-actions"><span>{status.owner === "ai" ? "所选目标已交给 AI" : "所选目标由你操作"}</span><button type="button" className="secondary-button" disabled={pending || (status.owner !== "ai" && (!ready || dirty))} onClick={() => {
      setPending(true); setError(null);
      void window.aevorenBot.hostComputer.control({ owner: status.owner === "ai" ? "user" : "ai", expectedEpoch: status.epoch }).then(result => { if (result.ok) setStatus(result.data); else setError(result.error.safeMessage); }).catch(() => setError("未能确认控制权，请刷新后检查。")).finally(() => setPending(false));
    }}>{status.owner === "ai" ? "我来操作" : "交给 AI"}</button></div> : null}
    <h3>Bot 的电脑</h3>
    <p className="computer-note">内置 Linux 电脑由本机 Docker 或 Colima 运行，按聊天与成员隔离；支持 computer use 和 browser use，无需 Docker Desktop。</p>
    <details><summary>内置电脑运行状态</summary><DockerStatusCard active /></details>
    <div className="settings-card settings-form-group"><label className="settings-row"><span><strong>默认电脑</strong><small>只影响新的电脑任务，已有任务保持原电脑。下方高级工具管理 Bot 的内置浏览器。</small></span><select aria-label="默认电脑" value={status?.configuration.target ?? "builtin"} disabled={!status || pending} onChange={event => void save({ target: event.target.value as "builtin" | "mac" })}><option value="builtin">Bot 的内置电脑</option><option value="mac" disabled={!status?.supported || !status.configuration.enabled}>这台 Mac</option></select></label></div>
    <details open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>内置浏览器高级工具</summary>
      {scopes.length > 1 ? <label className="field"><span>当前群成员</span><select aria-label="浏览器成员" value={scope?.executorBotId ?? ""} onChange={event => setSelected(event.target.value)}>{scopes.map(scope => <option key={scope.executorBotId} value={scope.executorBotId}>{scope.name}</option>)}</select></label> : null}
      {scope && advanced ? <BuiltinComputerPanel key={`${scope.sessionId}:${scope.executorBotId}`} sessionId={scope.sessionId} executorBotId={scope.executorBotId} ownerName={scope.name} mode="browser" /> : <p className="computer-note">{scope ? "展开后管理当前聊天的页面、下载与示范技能。" : "先打开一个 Bot 聊天或群聊，再管理对应浏览器。"}</p>}
    </details>
    {!status && !loadingTargets ? <button type="button" className="secondary-button" onClick={() => { setLoadingTargets(true); void load(); }}>重新读取设置</button> : null}
    {error ? <p className="dialog-error" role="alert">{error}</p> : null}
  </section>;
}
