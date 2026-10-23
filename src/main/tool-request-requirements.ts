/** Positive completion requirements only; the original request still governs execution permissions. */
export function positiveToolRequestText(text: string): string {
  return text.split(/([。！？!?\n；;]|\.(?=\s|$))/u).map(sentence => {
    // An unmet condition is not an unconditional requirement to perform its consequence.
    if (/如果|假如|(?:^|[，,])\s*若|\bif(?=\s)/iu.test(sentence)) return " ";
    sentence = sentence.replace(/不要只(?=读取|读入|保存|写入|使用|调用)/gu, "")
      .replace(/不是不要[^。！？!?\n；;]*/gu, " ");
    // A comma inside a prohibited list keeps the prohibition; an explicit new request ends it.
    sentence = sentence.replace(/但是|[但并](?=请|需要|必须|先|重新|实际|真实|已|成功|完成)|而是|\b(?:but|however|instead|and(?=\s+please\b))\b|[，,](?=\s*(?:请|还要|只(?:读取|创建|保存|写入)))/giu, "；");
    return sentence.split("；").map(clause => clause.replace(
      /(?:不要|不得|禁止|无需|无须|不需要|不允许|不必|不能|未要求|拒绝|取消|不(?=(?:再|重新)?(?:执行|进行|做|作|调用|使用|读取|读入|打开|解析|列出|搜索|抓取|访问|核验|保存|写入|创建|新建|组建|生成|计算|统计|联网|发布))|别(?=再?(?:用|使用|读取|写入|打开))|\b(?:do\s+not|don't|must\s+not|never|no\s+need\s+to|without|avoid)\b)[\s\S]*/iu,
      " ",
    )).join("；");
  }).join("");
}

export function requestsExactMeasurement(text: string): boolean {
  // Quoting a read receipt's length field does not request a new count. Explicit
  // counting/tool requests in another clause still require deterministic evidence.
  const actionable = positiveToolRequestText(text).split(/[，,。；;\n]/u).filter(clause => {
    const receiptLength = /长度/u.test(clause) && /(?:读取|加载|装载).{0,8}(?:回执|返回值)/u.test(clause) &&
      !/正文|文章|稿件|非空白|Unicode|码点|字数|词数/iu.test(clause);
    return !((/fullLength/iu.test(clause) || receiptLength) && /引用|采用|回显|quote|returned/iu.test(clause) &&
      !/text_measure|计算|统计|测量|recalculate|calculate|measure\b/iu.test(clause));
  }).join("；");
  return /字符数|字数|非空白字符|长度|word count|character count|text_measure/iu.test(actionable);
}
