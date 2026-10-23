import type { ApplicationSource } from "@shared/application-contracts";

/** Inputs are already schema-validated; JSON argv avoids shell interpretation. */
export function applicationDockerfile(base: string, source: ApplicationSource, id: string): string {
  const run = (args: string[]) => `RUN ${JSON.stringify(args)}`;
  const lines = [`FROM ${base}`, "USER root", 'WORKDIR /opt/aevoren-application'];
  if (source.kind === "apt" || source.kind === "deb") lines.push(run(["apt-get", "update"]));
  if (source.kind === "apt") lines.push(run(["apt-get", "install", "-y", "--no-install-recommends", ...source.packages]));
  else {
    lines.push(source.kind === "deb" ? "COPY payload ./application.deb" : "COPY payload ./payload");
    if (source.kind === "deb") {
      lines.push(run(["sh", "-ec", 'arch=$(dpkg-deb -f ./application.deb Architecture); test "$arch" = all || test "$arch" = "$(dpkg --print-architecture)"']),
        run(["apt-get", "install", "-y", "--no-install-recommends", "./application.deb"]));
    } else if (source.kind === "appimage") lines.push(run(["chmod", "755", "payload"]), run(["./payload", "--appimage-extract"]));
    else lines.push(run(["mv", "payload", "program"]), run(["chmod", "755", "program"]));
  }
  const executable = source.kind === "appimage" ? "/opt/aevoren-application/squashfs-root/AppRun" : source.executable;
  lines.push(run(["sh", "-ec", 'command -v -- "$1" >/dev/null', "verify-application", executable]),
    `LABEL io.aevoren.application-install=${JSON.stringify(id)}`, "USER 1000:1000", "WORKDIR /workspace");
  return lines.join("\n") + "\n";
}
