/**
 * Small line icons drawn for this app (spec §4.2: own SVG, no SF Symbols on the
 * Web). Built with DOM APIs so no markup string or inline style reaches the
 * page (CSP, spec §14).
 */

const PATHS = {
  device: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM11 18h2",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  key: "M15.5 13a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12.3 11.7 4 20M6 18l2 2M8.6 15.4l2 2",
  refresh: "M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.6 9.3a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2.1-2.5 3.5M12 16.8v.2",
  share: "M12 3v12M7.5 7.5 12 3l4.5 4.5M8 11H5v9h14v-9h-3",
  logout: "M10 4H5v16h5M14 8l4 4-4 4M18 12H9",
  trash: "M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  download: "M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14",
  close: "M6 6l12 12M18 6 6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
} as const;

export type IconName = keyof typeof PATHS;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Returns a decorative 24×24 stroke icon; the owning control carries the name. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("icon");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", PATHS[name]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}
