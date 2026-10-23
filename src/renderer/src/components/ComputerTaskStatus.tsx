import { useEffect, useState } from "react";
import type { ComputerTask } from "@shared/computer-task-contracts";
import type { BrowserScope } from "@shared/browser-contracts";

const labels: Record<ComputerTask["state"], string> = {
  queued: "等待执行", running: "正在执行", waiting_user: "等待你处理", paused: "已暂停",
  completed: "已完成", failed: "执行失败", cancelled: "已停止", interrupted: "上次执行已中断",
};

export function ComputerTaskStatus({ sessionId, executorBotId }: BrowserScope): React.JSX.Element | null {
  const [task, setTask] = useState<ComputerTask | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true, revision = 0;
    const scope = { sessionId, executorBotId };
    const load = async (): Promise<void> => {
      const request = ++revision;
      const result = await window.aevorenBot.computerTasks.list(scope);
      if (!live || request !== revision) return;
      if (result.ok) setTask(result.data[0] ?? null);
      else setError(result.error.safeMessage);
    };
    void load();
    const unsubscribe = window.aevorenBot.computerTasks.onChanged(next => {
      if (next.sessionId === sessionId && next.executorBotId === executorBotId) void load();
    });
    return () => { live = false; unsubscribe(); };
  }, [sessionId, executorBotId]);
  if (!task) return error ? <p className="computer-warning" role="status">{error}</p> : null;
  async function act(resume: boolean): Promise<void> {
    if (!task || pending) return;
    setPending(true); setError(null);
    try {
      const input = { sessionId, executorBotId, id: task.id, expectedVersion: task.version };
      const result = await window.aevorenBot.computerTasks[resume ? "resume" : "cancel"](input);
      if (result.ok) setTask(result.data); else setError(result.error.safeMessage);
    } catch { setError("未能确认任务状态，请刷新电脑页。"); }
    finally { setPending(false); }
  }
  return <div className="computer-task-status" role="status">
    <div><strong>{labels[task.state]}</strong><span>{task.target === "mac" ? "这台 Mac" : "内置电脑"} · {task.actionCount} 步</span></div>
    <p>{task.goal}</p>
    {task.result ? <p>{task.result}</p> : null}
    {task.errorCode ? <details><summary>诊断详情</summary><code>{task.errorCode}</code></details> : null}
    {["queued", "running", "waiting_user", "paused", "interrupted"].includes(task.state) ? <div className="computer-actions">
      {["paused", "interrupted"].includes(task.state) ? <button className="secondary-button" disabled={pending} onClick={() => void act(true)}>继续</button> : null}
      <button className="text-button" disabled={pending} onClick={() => void act(false)}>停止任务</button>
    </div> : null}
    {error ? <p className="computer-warning">{error}</p> : null}
  </div>;
}
