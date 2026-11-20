import type { SurfaceReadout, SurfaceReadoutStatus } from "@kolu/surface/solid";
import type { StatusHue } from "@odu/face/ui";

export const CONNECTION: Record<
  SurfaceReadoutStatus,
  { label: string; hue: StatusHue }
> = {
  connecting: { label: "connecting", hue: "grey" },
  live: { label: "live", hue: "green" },
  degraded: { label: "partly live", hue: "amber" },
  reconnecting: {
    label: "reconnecting — showing the last thing the service said",
    hue: "amber",
  },
  retired: {
    label: "this page is bound to a service that has been replaced — reload",
    hue: "red",
  },
};

export function wireText(readout: SurfaceReadout): {
  text: string;
  hue: StatusHue;
} {
  const said = CONNECTION[readout.status];
  return {
    text:
      readout.status === "degraded"
        ? `${said.label} — nothing is arriving on ${readout.stopped.join(", ")}`
        : said.label,
    hue: said.hue,
  };
}

export function faviconSvg(hue: "red" | "amber"): string {
  const dot = hue === "red" ? "#ff6b5e" : "#f2c14e";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="#0a0d0c"/>` +
    `<text x="6" y="23" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" ` +
    `font-size="18" font-weight="700" fill="#7a8982">$</text>` +
    `<circle cx="24" cy="24" r="6" fill="${dot}"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
