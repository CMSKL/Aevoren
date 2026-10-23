import { z } from "zod";

export const COMPUTER_LAYOUT_VERSION = 2;
export function computerVolumes(environmentId: string) {
  z.string().uuid().parse(environmentId);
  const volume = (kind: string, target: string) => ({ source: `aevoren-computer-${kind}-${environmentId}-v2`, target });
  return {
    home: volume("home", "/home/aevoren"), profile: volume("profile", "/home/aevoren/.config/chromium"),
    downloads: volume("downloads", "/workspace/Downloads"), display: volume("display", "/tmp/.X11-unix"),
  };
}
export const volumeArgument = ({ source, target }: { source: string; target: string }): string => `type=volume,source=${source},target=${target}`;
