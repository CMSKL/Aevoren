import { useEffect, useRef, useState } from "react";
import type { BrowserScope } from "@shared/browser-contracts";
import type { Application, ApplicationSource } from "@shared/application-contracts";
const stateNames: Record<Application["state"], string> = { building: "正在安装", pending: "安装完成，待电脑空闲后应用", installed: "可用", failed: "安装失败", interrupted: "安装已中断" };

export function ComputerApplications({ sessionId, executorBotId }: BrowserScope): React.JSX.Element {
  const [applications, setApplications] = useState<Application[]>([]), [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(""), [kind, setKind] = useState<ApplicationSource["kind"]>("apt"), [packages, setPackages] = useState("");
  const [url, setUrl] = useState(""), [sha256, setSha256] = useState(""), [executable, setExecutable] = useState("");
  const [pending, setPending] = useState(false), [refresh, setRefresh] = useState(0);
  const intent = useRef<{ payload: string; nonce: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const result = await window.aevorenBot.applications.list({ sessionId, executorBotId });
        if (!current) return;
        if (result.ok) { setApplications(result.data); if (result.data.some(value => ["building", "pending"].includes(value.state))) timer = setTimeout(() => void load(), 3_000); }
        else setError(result.error.safeMessage);
      } catch { if (current) setError("无法读取应用状态。"); }
    };
    void load(); return () => { current = false; clearTimeout(timer); };
  }, [sessionId, executorBotId, refresh]);
  async function install(): Promise<void> {
    if (pending) return;
    const source: ApplicationSource = kind === "apt" ? { kind, packages: packages.trim().split(/\s+/), executable }
      : kind === "deb" ? { kind, url, sha256, executable } : kind === "appimage" ? { kind, url, sha256, executable: "AppRun" } : { kind, url, sha256, executable: "/opt/aevoren-application/program" };
    const input = { sessionId, executorBotId, name, source }, payload = JSON.stringify(input);
    if (intent.current?.payload !== payload) intent.current = { payload, nonce: crypto.randomUUID() };
    setPending(true); setError(null);
    try {
      const result = await window.aevorenBot.applications.install({ ...input, clientNonce: intent.current.nonce });
      if (!live.current) return;
      if (result.ok) { intent.current = null; setRefresh(value => value + 1); } else setError(result.error.safeMessage);
    } catch { if (live.current) setError("安装请求结果未确认。再次提交相同配置将沿用原请求。"); }
    finally { if (live.current) setPending(false); }
  }
  async function launch(id: string): Promise<void> {
    setPending(true); setError(null);
    try {
      const result = await window.aevorenBot.applications.launch({ sessionId, executorBotId, id, args: [], clientNonce: crypto.randomUUID() });
      if (!live.current) return;
      if (!result.ok) setError(result.error.safeMessage);
      else if (result.data.state !== "running") setError(`应用已退出（${result.data.exitCode ?? "未知退出码"}），请查看电脑画面。`);
    } catch { if (live.current) setError("启动结果未确认，请先查看电脑窗口，避免重复启动。"); }
    finally { if (live.current) setPending(false); }
  }
  return <details className="computer-advanced"><summary>电脑应用</summary>
    <p className="computer-note">终端、文件和应用共用这台隔离电脑的文件与浏览器资料。</p>
    {applications.map(application => <div key={application.id} className="computer-resource-row"><span>{application.name} · {stateNames[application.state]}</span>
      {application.state === "installed" ? <button className="text-button" disabled={pending} onClick={() => void launch(application.id)}>打开</button> : null}
      {application.error ? <p className="computer-error">{application.error}</p> : null}
    </div>)}
    <details><summary>安装 Linux 应用</summary>
      <label className="field"><span>名称</span><input value={name} onChange={event => setName(event.target.value)} maxLength={120} /></label>
      <label className="field"><span>来源</span><select value={kind} onChange={event => setKind(event.target.value as ApplicationSource["kind"])}><option value="apt">发行版软件包</option><option value="deb">.deb</option><option value="appimage">AppImage</option><option value="portable">便携可执行文件</option></select></label>
      {kind === "apt" ? <label className="field"><span>软件包（空格分隔）</span><input value={packages} onChange={event => setPackages(event.target.value)} /></label> : <>
        <label className="field"><span>HTTPS 下载地址</span><input value={url} onChange={event => setUrl(event.target.value)} /></label>
        <label className="field"><span>SHA-256</span><input value={sha256} onChange={event => setSha256(event.target.value)} maxLength={64} /></label>
      </>}
      {["apt", "deb"].includes(kind) ? <label className="field"><span>启动程序</span><input value={executable} onChange={event => setExecutable(event.target.value)} placeholder="例如 /usr/bin/gimp" /></label> : null}
      <p className="computer-note">支持兼容当前 Linux 架构的应用。安装失败保留原电脑；不支持 Windows 或 macOS 安装程序。</p>
      <button className="secondary-button" disabled={pending || !name.trim()} onClick={() => void install()}>安装</button>
    </details>
    <button className="text-button" disabled={pending} onClick={() => setRefresh(value => value + 1)}>刷新应用</button>
    {error ? <p className="computer-error" role="alert">{error}</p> : null}
  </details>;
}
