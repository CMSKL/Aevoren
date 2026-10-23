import type { ElementHandle } from "playwright-core";

/** Capture the actual node, not a selector which could resolve to a replacement. */
export async function targetFingerprint(target: ElementHandle, focusOnly = false): Promise<string | null> {
  return target.evaluate((node, focusOnly) => {
    if (!(node instanceof Element) || !node.isConnected || !node.getClientRects().length) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") return null;
    return JSON.stringify({ tag: node.tagName, attributes: [...node.attributes].map(attr => [attr.name, attr.value]),
      text: focusOnly && node.tagName !== "INPUT" && node.tagName !== "TEXTAREA" && !(node as HTMLElement).isContentEditable ? null : node.textContent?.slice(0, 2_000), value: "value" in node ? String(node.value) : null,
      rect: [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value * 10) / 10) });
  }, focusOnly).catch(() => null);
}
