import { describe, expect, it } from "vitest";
import { positiveToolRequestText, requestsExactMeasurement } from "./tool-request-requirements";
import { requestedReadPaths } from "./workspace-read-requirements";
import { requestedWritePaths } from "./workspace-write-requirements";

describe("negative execution lists from the real S4 request", () => {
  it.each(["不执行", "不进行", "不再执行", "不重新执行", "不做"])("does not require any action in a %s list", prefix => {
    const text = `${prefix}研究、创建 report.md 或读取 secret.md；请只查询已有状态。`;
    expect(positiveToolRequestText(text)).not.toContain("创建");
    expect(requestedWritePaths(text)).toEqual([]);
    expect(requestedReadPaths(text)).toEqual([]);
  });
  it("does not require counting explicitly ruled out as a follow-up action", () => {
    expect(requestsExactMeasurement("回显 fullLength，不作任何正文字符数统计。")).toBe(false);
    expect(requestsExactMeasurement("回显 fullLength，不重新计算正文的字符数。")).toBe(false);
  });
  it("does not turn the real S4 no-count output instruction into a count requirement", () => {
    expect(requestsExactMeasurement("然后一行职责，不复述规范未来动作，不输出自行计算字数。")).toBe(false);
    expect(requestsExactMeasurement("不输出正文字符数、也不输出自行计算的长度。")).toBe(false);
    expect(requestsExactMeasurement("不报告fullLength或任何正文长度。")).toBe(false);
    expect(requestsExactMeasurement("最后报告任务ID与观察状态，不自行估计字数或字节数。")).toBe(false);
    expect(requestsExactMeasurement("不估字数或字节数。")).toBe(false);
    expect(requestsExactMeasurement("请报告正文长度。")).toBe(true);
    expect(requestsExactMeasurement("不输出自行计算字数，但请用 text_measure 统计正文长度。")).toBe(true);
  });
  it("quotes a read receipt's length without requesting an independent count", () => {
    expect(requestsExactMeasurement("只回显 fullLength。长度仅引用读取回执，不重新统计正文。")).toBe(false);
    expect(requestsExactMeasurement("回显读取回执的长度，不重新计算文本。")).toBe(false);
    expect(requestsExactMeasurement("正文的长度必须计算，不要只引用读取回执。")).toBe(true);
    expect(requestsExactMeasurement("长度仅引用读取回执；请用 text_measure 统计正文长度。")).toBe(true);
  });
  it("keeps an explicit positive read, write and count after the negative list", () => {
    const text = "不执行研究、创建 secret.md 或读取 private.md；请读取 public.md；请创建 result.md；请统计结果的字数。";
    expect(requestedReadPaths(text)).toEqual(["public.md"]);
    expect(requestedWritePaths(text)).toEqual(["result.md"]);
    expect(requestsExactMeasurement(text)).toBe(true);
  });
});
